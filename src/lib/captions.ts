import { YoutubeTranscript } from "youtube-transcript";

export type CaptionResult =
  | { ok: true; text: string; segments: { text: string; offset: number }[] }
  | { ok: false; reason: "no_captions" | "unavailable" | "error"; message: string };

/**
 * Fetch captions for a video and return both a clean concatenated string
 * (for the LLM) and timestamped segments (kept for future chaptering).
 *
 * NOTE: YouTube frequently blocks datacenter/cloud IPs from these endpoints.
 * If this fails in production but works locally, route through a residential
 * proxy or a managed transcript API. See plan "Public-app concerns".
 */
export async function fetchCaptions(videoId: string): Promise<CaptionResult> {
  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId);
    if (!raw || raw.length === 0) {
      return { ok: false, reason: "no_captions", message: "No captions found for this video." };
    }
    const segments = raw.map((s) => ({ text: decodeEntities(s.text), offset: s.offset }));
    const text = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { ok: true, text, segments };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The library throws a "Transcript is disabled" style error in these cases.
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
