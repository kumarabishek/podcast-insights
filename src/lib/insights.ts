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

// Schema the MODEL fills. It returns a verbatim `quote`; we compute the
// timestamp from it ourselves (the model is unreliable at second math).
const InsightSchema = z.object({
  title: z.string().describe("A short, punchy headline for the insight (≤ 12 words)."),
  detail: z
    .string()
    .describe("1-3 sentences explaining the insight, takeaway, or claim and why it matters."),
  quote: z
    .string()
    .optional()
    .describe(
      "A SHORT phrase (5-12 words) copied EXACTLY, word-for-word, from the transcript at the moment this insight is discussed. Do not paraphrase. Omit if none fits.",
    ),
});

const InsightResultSchema = z.object({
  summary: z.string().describe("A 2-3 sentence TL;DR of what the episode is about."),
  insights: z
    .array(InsightSchema)
    .describe("The most important, non-obvious insights and takeaways, ordered by significance."),
});

// Stored shape adds startTime (seconds), computed server-side from `quote`.
export type Insight = z.infer<typeof InsightSchema> & { startTime?: number };
export type InsightResult = { summary: string; insights: Insight[] };

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

// Appended to every prompt. We resolve the timestamp from the quote ourselves,
// so accuracy depends only on the quote being copied verbatim.
const QUOTE_NOTE = `The transcript may be annotated with [m:ss] timestamps. For every insight, include a "quote": a short phrase (5-12 words) copied EXACTLY and word-for-word from the transcript text, in the SAME language as the transcript, taken from the exact moment that insight is discussed. Do NOT include the [m:ss] marker in the quote, do NOT paraphrase, do NOT translate, and do NOT invent text — copy real words verbatim so the moment can be located. Omit the quote only if no suitable verbatim phrase exists.`;

function promptFor(style: StyleId): string {
  return `${PROMPTS[style]}\n\n${QUOTE_NOTE}`;
}

// --- Timestamp resolution (verbatim-quote → seconds) -------------------------

function normalizeText(s: string): string {
  // Unicode-aware: keep letters/numbers of ANY script (Arabic, CJK, etc.),
  // drop punctuation, collapse whitespace.
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type TimedLine = { sec: number; norm: string };

function parseTimedLines(transcript: string): TimedLine[] {
  const lines: TimedLine[] = [];
  for (const raw of transcript.split("\n")) {
    const m = raw.match(/^\[(\d+):(\d{2})\]\s*(.*)$/);
    if (m) lines.push({ sec: parseInt(m[1], 10) * 60 + parseInt(m[2], 10), norm: normalizeText(m[3]) });
  }
  return lines;
}

function findQuoteSec(lines: TimedLine[], quoteNorm: string): number | null {
  if (quoteNorm.length < 6) return null;
  // 1) exact phrase within one ~30s line
  for (const l of lines) if (l.norm.includes(quoteNorm)) return l.sec;
  // 2) phrase spanning a line boundary
  for (let i = 0; i < lines.length - 1; i++) {
    if (`${lines[i].norm} ${lines[i + 1].norm}`.includes(quoteNorm)) return lines[i].sec;
  }
  // 3) fall back to the first 6 words of the quote
  const short = quoteNorm.split(" ").slice(0, 6).join(" ");
  if (short.length >= 10 && short !== quoteNorm) {
    for (const l of lines) if (l.norm.includes(short)) return l.sec;
    for (let i = 0; i < lines.length - 1; i++) {
      if (`${lines[i].norm} ${lines[i + 1].norm}`.includes(short)) return lines[i].sec;
    }
  }
  return null;
}

/**
 * Compute each insight's startTime by locating its verbatim quote in the timed
 * transcript. We never trust a model-supplied number — if the quote can't be
 * found (or the transcript has no timestamps), we leave startTime unset so the
 * UI shows no (potentially wrong) link.
 */
export function resolveInsightTimestamps(transcript: string, insights: Insight[]): void {
  const lines = parseTimedLines(transcript);
  const maxSec = lines.length ? lines[lines.length - 1].sec : 0;
  for (const ins of insights) {
    ins.startTime = undefined;
    if (!lines.length || !ins.quote) continue;
    const sec = findQuoteSec(lines, normalizeText(ins.quote));
    if (sec != null) ins.startTime = Math.min(sec, maxSec);
  }
}

/** Locate a single verbatim quote in the timed transcript → seconds (or undefined). */
function quoteToSeconds(transcript: string, quote: string | undefined): number | undefined {
  if (!quote) return undefined;
  const lines = parseTimedLines(transcript);
  if (!lines.length) return undefined;
  const sec = findQuoteSec(lines, normalizeText(quote));
  return sec == null ? undefined : Math.min(sec, lines[lines.length - 1].sec);
}

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
  const out =
    PROVIDER === "gemini"
      ? await extractWithGemini(transcript, meta, style)
      : await extractWithClaude(transcript, meta, style);
  // Compute trustworthy timestamps from each insight's verbatim quote.
  resolveInsightTimestamps(transcript, out.result.insights);
  return out;
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
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
          quote: { type: Type.STRING },
        },
        required: ["title", "detail"],
        propertyOrdering: ["title", "detail", "quote"],
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
            systemInstruction: promptFor(style),
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
      { type: "text", text: promptFor(style) },
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

// --- Q&A: ask a question about the video -------------------------------------

const AnswerSchema = z.object({
  answer: z
    .string()
    .describe(
      "A concise, direct answer (2-4 sentences) based ONLY on the transcript. If the transcript doesn't address the question, clearly say it isn't covered.",
    ),
  quote: z
    .string()
    .optional()
    .describe(
      "A short verbatim phrase (5-12 words) copied EXACTLY from the transcript (same language, no [m:ss] marker, no paraphrase) marking where the answer is discussed. Omit if not tied to a specific moment.",
    ),
});

export type AnswerResult = { answer: string; quote?: string; startTime?: number };

const GEMINI_ANSWER_SCHEMA = {
  type: Type.OBJECT,
  properties: { answer: { type: Type.STRING }, quote: { type: Type.STRING } },
  required: ["answer"],
  propertyOrdering: ["answer", "quote"],
};

const ASK_SYSTEM = `You answer a user's question about a podcast episode using ONLY the provided transcript. Give a concise, direct answer. If the transcript does not address the question, clearly say it isn't covered in this episode — do not make up information.

The transcript may be annotated with [m:ss] timestamps. Include a "quote": a short verbatim phrase (5-12 words) copied EXACTLY from the transcript (same language, no [m:ss] marker, no paraphrase) marking where the answer is discussed, so the user can jump to that moment. Omit the quote if the answer isn't tied to a specific moment.`;

export async function answerQuestion(
  transcript: string,
  meta: { title: string; channel: string },
  question: string,
): Promise<{ result: AnswerResult; model: string }> {
  const context = buildContext(transcript, meta);
  let result: AnswerResult;
  let model: string;

  if (PROVIDER === "gemini") {
    const models =
      GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL
        ? [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]
        : [GEMINI_MODEL];
    let lastErr: unknown;
    let got: AnswerResult | null = null;
    model = models[0];
    for (let i = 0; i < models.length; i++) {
      model = models[i];
      try {
        const response = await withRetry(() =>
          getGemini().models.generateContent({
            model,
            contents: `${context}\n\nQuestion: ${question}`,
            config: {
              systemInstruction: ASK_SYSTEM,
              responseMimeType: "application/json",
              responseSchema: GEMINI_ANSWER_SCHEMA,
            },
          }),
        );
        const text = response.text;
        if (!text) throw new Error("Gemini returned no content.");
        got = AnswerSchema.parse(JSON.parse(text));
        break;
      } catch (err) {
        lastErr = err;
        if ((isTransientError(err) || isRateLimitError(err)) && i < models.length - 1) continue;
        throw err;
      }
    }
    if (!got) throw lastErr;
    result = got;
  } else {
    model = ANTHROPIC_MODEL;
    const response = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: [
        { type: "text", text: context, cache_control: { type: "ephemeral" } },
        { type: "text", text: ASK_SYSTEM },
      ],
      output_config: { format: zodOutputFormat(AnswerSchema) },
      messages: [{ role: "user", content: question }],
    });
    if (!response.parsed_output) throw new Error("Model did not return structured output.");
    result = response.parsed_output;
  }

  result.startTime = quoteToSeconds(transcript, result.quote);
  return { result, model };
}
