import { YoutubeTranscript } from "youtube-transcript";

export type CaptionResult =
  | { ok: true; text: string; segments: { text: string; offset: number }[] }
  | { ok: false; reason: "no_captions" | "unavailable" | "error"; message: string };

/**
 * Fetch captions for a video and return both a clean concatenated string
 * (for the LLM) and timestamped segments (kept for future chaptering).
 *
 * In production, YouTube blocks datacenter IPs from its caption endpoints, so
 * we route through Supadata (a managed transcript API) when SUPADATA_API_KEY is
 * set. Locally (residential IP) we use the free youtube-transcript library.
 */
export async function fetchCaptions(videoId: string): Promise<CaptionResult> {
  if (process.env.SUPADATA_API_KEY) return fetchViaSupadata(videoId);
  return fetchViaLibrary(videoId);
}

/**
 * Build a transcript annotated with [m:ss] timestamps (one line per ~30s
 * bucket) so the LLM can attribute each insight to a span of the episode.
 * Returns "" if there are no timestamped segments.
 */
export function buildTimestampedTranscript(
  segments: { text: string; offset: number }[],
): string {
  if (!segments.length) return "";
  const BUCKET = 30; // seconds per labelled line
  const lines: string[] = [];
  let bucketStart = Math.floor(segments[0].offset / 1000);
  let buf: string[] = [];

  for (const s of segments) {
    const t = Math.floor(s.offset / 1000);
    if (t - bucketStart >= BUCKET && buf.length) {
      lines.push(`[${clock(bucketStart)}] ${buf.join(" ")}`);
      buf = [];
      bucketStart = t;
    }
    buf.push(s.text);
  }
  if (buf.length) lines.push(`[${clock(bucketStart)}] ${buf.join(" ")}`);
  return lines.join("\n");
}

function clock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- Supadata (production: works from cloud IPs) -----------------------------

const SUPADATA_BASE = "https://api.supadata.ai/v1/transcript";

type SupadataContent = string | { text: string; offset?: number }[];

async function fetchViaSupadata(videoId: string): Promise<CaptionResult> {
  const key = process.env.SUPADATA_API_KEY as string;
  const headers = { "x-api-key": key };
  const url = `${SUPADATA_BASE}?url=${encodeURIComponent(`https://youtu.be/${videoId}`)}`;

  try {
    const res = await fetch(url, { headers, cache: "no-store" });

    // Synchronous result (short videos).
    if (res.status === 200) {
      const data = (await res.json()) as { content?: SupadataContent };
      return normalize(data.content);
    }

    // Async job (videos > ~20 min — i.e. most podcasts). Poll until done.
    if (res.status === 202) {
      const { jobId } = (await res.json()) as { jobId?: string };
      if (!jobId) return { ok: false, reason: "error", message: "Supadata returned no jobId." };
      return pollSupadataJob(jobId, headers);
    }

    return mapSupadataError(res.status, await safeText(res));
  } catch (err) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function pollSupadataJob(
  jobId: string,
  headers: Record<string, string>,
): Promise<CaptionResult> {
  // Cap polling so we stay within the serverless function budget (~30s),
  // leaving headroom for the LLM call. Status checks don't cost credits.
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${SUPADATA_BASE}/${jobId}`, { headers, cache: "no-store" });
    if (!res.ok) continue;
    const data = (await res.json()) as { status?: string; content?: SupadataContent; error?: string };
    if (data.status === "completed") return normalize(data.content);
    if (data.status === "failed") {
      return { ok: false, reason: "no_captions", message: data.error ?? "Transcript unavailable." };
    }
    // queued | active → keep polling
  }
  return { ok: false, reason: "error", message: "Transcript is still processing. Please try again shortly." };
}

function normalize(content: SupadataContent | undefined): CaptionResult {
  if (!content || (Array.isArray(content) && content.length === 0)) {
    return { ok: false, reason: "no_captions", message: "No captions found for this video." };
  }
  if (typeof content === "string") {
    const text = content.replace(/\s+/g, " ").trim();
    if (!text) return { ok: false, reason: "no_captions", message: "No captions found for this video." };
    return { ok: true, text, segments: [] };
  }
  const segments = content.map((s) => ({ text: s.text, offset: s.offset ?? 0 }));
  const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return { ok: true, text, segments };
}

function mapSupadataError(status: number, body: string): CaptionResult {
  if (status === 404 || /transcript-unavailable|not found|no transcript/i.test(body)) {
    return { ok: false, reason: "no_captions", message: "Captions are unavailable for this video." };
  }
  return { ok: false, reason: "error", message: `Supadata error ${status}: ${body.slice(0, 200)}` };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// --- youtube-transcript library (local dev: residential IP) ------------------

async function fetchViaLibrary(videoId: string): Promise<CaptionResult> {
  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId);
    if (!raw || raw.length === 0) {
      return { ok: false, reason: "no_captions", message: "No captions found for this video." };
    }
    const segments = raw.map((s) => ({ text: decodeEntities(s.text), offset: s.offset }));
    const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
    return { ok: true, text, segments };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/disabled|not available|Could not find|no transcript/i.test(msg)) {
      return { ok: false, reason: "no_captions", message: "Captions are disabled for this video." };
    }
    return { ok: false, reason: "error", message: msg };
  }
}

/** youtube-transcript returns HTML-escaped text (&amp;#39; etc.). Decode the common ones. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;#39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
