import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, Type, ApiError } from "@google/genai";
import { z } from "zod";
import type { StyleId } from "./styles";

// Provider: defaults to Gemini when a Gemini key is present, else Anthropic.
// Override explicitly with LLM_PROVIDER=gemini|anthropic.
const PROVIDER =
  process.env.LLM_PROVIDER ?? (process.env.GEMINI_API_KEY ? "gemini" : "anthropic");

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
// If the primary model is overloaded/quota-limited, fall back to this one.
// flash-lite is less contended and has a higher free-tier quota.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash-lite";
const ANTHROPIC_MODEL = process.env.MODEL ?? "claude-sonnet-4-6";

const InsightSchema = z.object({
  title: z.string().describe("A short, punchy headline for the insight (≤ 12 words)."),
  detail: z
    .string()
    .describe("1-3 sentences explaining the insight, takeaway, or claim and why it matters."),
});

const InsightResultSchema = z.object({
  summary: z.string().describe("A 2-3 sentence TL;DR of what the episode is about."),
  insights: z
    .array(InsightSchema)
    .describe("The most important, non-obvious insights and takeaways, ordered by significance."),
});

export type InsightResult = z.infer<typeof InsightResultSchema>;

// One system prompt per depth/style. The user picks which in the UI.
const PROMPTS: Record<StyleId, string> = {
  A: `You are an expert analyst who distills podcast conversations into actionable takeaways.

Extract the most useful, applicable lessons a motivated listener could act on. Prioritize: concrete advice, decision-making heuristics, mental models, and "do this / avoid that" guidance. For each takeaway, make the title an imperative or a crisp claim, and use the detail to explain the reasoning and when it applies.

Rules:
- Favor what's actionable and non-obvious over general recap.
- Skip ads, intros, tangents, and pleasantries.
- Don't pad. Surface only takeaways that genuinely earn a spot — typically 5-10.
- Be specific: if a number, framework, or example was given, include it.`,

  B: `You are a sharp analyst who extracts the full substance of a podcast so a reader never needs to listen to it.

Capture the real intellectual content of the conversation: the central arguments and how they were defended, surprising or counterintuitive claims, supporting data and examples, mental models, and points of disagreement or tension. Preserve nuance — if a claim was hedged or contested, say so. Attribute notable positions to who argued them when it matters.

Rules:
- Go for depth and faithfulness over brevity; capture what was actually said, not generic summaries.
- Distinguish strong claims from speculation.
- Skip ads and filler, but don't flatten genuine complexity.
- Aim for 8-15 insights depending on how substantive the episode is.`,

  C: `You are an editor who writes a smart briefing on a podcast episode for a busy reader.

Open with a tight TL;DR of what the episode covers and why someone might care. Then surface the key insights grouped naturally by theme. Highlight the genuinely memorable moments: standout claims, surprising facts, strong opinions, and notable people, books, tools, or companies mentioned.

Rules:
- Keep it scannable and engaging — this is a briefing, not a transcript.
- Lead with substance a reader would find interesting or share-worthy.
- Skip ads, sponsorships, and small talk.
- 6-12 insights, ordered by significance.`,
};

/** Insights are stored per video keyed by style: { A: {...}, B: {...} }. */
export type InsightsByStyle = Partial<Record<StyleId, InsightResult>>;

export function parseInsightsMap(json: string | null): InsightsByStyle {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    // Only treat it as a valid style-map; ignore any legacy/other shapes.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: InsightsByStyle = {};
      for (const k of ["A", "B", "C"] as StyleId[]) {
        if (v[k]) out[k] = v[k] as InsightResult;
      }
      return out;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function errStatus(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status;
  const e = err as { status?: number; code?: number };
  return e?.status ?? e?.code;
}

/** True if the error is a provider rate-limit / quota-exhausted error (HTTP 429). */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  return errStatus(err) === 429;
}

/** Transient server-side errors worth retrying (overloaded / internal). */
function isTransientError(err: unknown): boolean {
  const s = errStatus(err);
  return s === 503 || s === 500;
}

/** Run `fn`, retrying transient 5xx errors with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // 1s, 2s, 4s…
    }
  }
  throw lastErr;
}

function buildContext(transcript: string, meta: { title: string; channel: string }): string {
  return `Podcast: "${meta.title}" by ${meta.channel}\n\nTranscript:\n${transcript}`;
}

/**
 * Send a transcript to the configured LLM and get back structured key insights.
 * Dispatches to Gemini or Claude based on LLM_PROVIDER.
 */
export async function extractInsights(
  transcript: string,
  meta: { title: string; channel: string },
  style: StyleId,
): Promise<{ result: InsightResult; model: string }> {
  return PROVIDER === "gemini"
    ? extractWithGemini(transcript, meta, style)
    : extractWithClaude(transcript, meta, style);
}

// --- Gemini ------------------------------------------------------------------

// Gemini's structured-output schema (mirrors InsightResultSchema).
const GEMINI_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    insights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING }, detail: { type: Type.STRING } },
        required: ["title", "detail"],
        propertyOrdering: ["title", "detail"],
      },
    },
  },
  required: ["summary", "insights"],
  propertyOrdering: ["summary", "insights"],
};

let _gemini: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (!_gemini) _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _gemini;
}

async function extractWithGemini(
  transcript: string,
  meta: { title: string; channel: string },
  style: StyleId,
): Promise<{ result: InsightResult; model: string }> {
  // Primary, then fallback. Each model gets its own retry-with-backoff;
  // we only advance to the fallback if the primary is overloaded (5xx) or
  // quota-limited (429) — not for genuine bad output.
  const models =
    GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL
      ? [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]
      : [GEMINI_MODEL];

  let lastErr: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLast = i === models.length - 1;
    try {
      const response = await withRetry(() =>
        getGemini().models.generateContent({
          model,
          contents: buildContext(transcript, meta),
          config: {
            systemInstruction: PROMPTS[style],
            responseMimeType: "application/json",
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      );
      const text = response.text;
      if (!text) throw new Error("Gemini returned no content.");
      // Validate against the same zod schema for a uniform, trustworthy shape.
      const result = InsightResultSchema.parse(JSON.parse(text));
      return { result, model };
    } catch (err) {
      lastErr = err;
      const recoverable = isTransientError(err) || isRateLimitError(err);
      if (recoverable && !isLast) continue; // try the fallback model
      throw err;
    }
  }
  throw lastErr;
}

// --- Claude ------------------------------------------------------------------

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

async function extractWithClaude(
  transcript: string,
  meta: { title: string; channel: string },
  style: StyleId,
): Promise<{ result: InsightResult; model: string }> {
  const response = await getAnthropic().messages.parse({
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    system: [
      {
        // Transcript first + cached: identical across styles, so all styles
        // (and re-runs) share this cached prefix. The style-specific prompt
        // goes after the breakpoint so swapping styles doesn't invalidate it.
        type: "text",
        text: buildContext(transcript, meta),
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: PROMPTS[style] },
    ],
    output_config: { format: zodOutputFormat(InsightResultSchema) },
    messages: [
      {
        role: "user",
        content:
          "Extract the key insights and takeaways from this podcast episode as structured output.",
      },
    ],
  });

  if (!response.parsed_output) {
    throw new Error(`Model did not return structured output (stop_reason: ${response.stop_reason}).`);
  }
  return { result: response.parsed_output, model: ANTHROPIC_MODEL };
}
