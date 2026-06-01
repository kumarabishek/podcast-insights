// Spike: validate caption fetching end-to-end before building UI.
// Usage: node scripts/spike-captions.mjs <youtube-url-or-id>
import { YoutubeTranscript } from "youtube-transcript";

function parseVideoId(input) {
  const url = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  try {
    const p = new URL(url);
    const host = p.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return p.pathname.slice(1).split("/")[0];
    const v = p.searchParams.get("v");
    if (v) return v;
    const m = p.pathname.match(/^\/(embed|live|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[2];
  } catch {}
  return null;
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/spike-captions.mjs <youtube-url-or-id>");
  process.exit(1);
}
const id = parseVideoId(arg);
console.log("videoId:", id);

try {
  const t = await YoutubeTranscript.fetchTranscript(id);
  const text = t.map((s) => s.text).join(" ").replace(/\s+/g, " ");
  console.log("segments:", t.length);
  console.log("chars:", text.length, "| ~words:", Math.round(text.split(" ").length));
  console.log("\n--- first 400 chars ---\n" + text.slice(0, 400));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exit(2);
}
