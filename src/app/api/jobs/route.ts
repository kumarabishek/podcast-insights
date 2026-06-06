import { after } from "next/server";
import { prisma } from "@/lib/db";
import { parseVideoId, fetchVideoMeta } from "@/lib/youtube";
import { processJob } from "@/lib/worker";
import { parseInsightsMap } from "@/lib/insights";
import { DEFAULT_STYLE, isStyleId } from "@/lib/styles";
import { verifyTurnstile, clientIp } from "@/lib/turnstile";

// The background worker (caption fetch + LLM call) runs via after() within
// this function's lifetime, so give it room. 60s is the Vercel Hobby ceiling.
export const maxDuration = 60;

/**
 * POST /api/jobs — submit a YouTube URL for insight extraction.
 * Returns { jobId, cached } immediately; processing runs via after().
 */
export async function POST(request: Request) {
  let body: { url?: string; style?: string; turnstileToken?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Bot protection (no-op when Turnstile isn't configured).
  const human = await verifyTurnstile(body.turnstileToken, clientIp(request));
  if (!human) {
    return Response.json({ error: "Verification failed. Please try again." }, { status: 403 });
  }

  const url = body.url?.trim();
  if (!url) return Response.json({ error: "Missing 'url'." }, { status: 400 });

  const style = isStyleId(body.style) ? body.style : DEFAULT_STYLE;

  const videoId = parseVideoId(url);
  if (!videoId) return Response.json({ error: "Could not parse a YouTube video ID from that URL." }, { status: 400 });

  // Cache hit: this video already analyzed at this style → return a done job.
  const existing = await prisma.episode.findUnique({ where: { videoId } });
  if (existing && parseInsightsMap(existing.insights)[style]) {
    const job = await prisma.job.create({
      data: { videoId, url, style, status: "done", episodeId: existing.id },
    });
    return Response.json({ jobId: job.id, cached: true });
  }

  // Fetch lightweight metadata (no API key needed).
  const meta = await fetchVideoMeta(videoId);
  if (!meta) {
    return Response.json({ error: "Video is unavailable or private." }, { status: 404 });
  }

  // Upsert the Episode shell (transcript filled in by the worker).
  const episode = await prisma.episode.upsert({
    where: { videoId },
    update: { title: meta.title, channel: meta.channel, thumbnail: meta.thumbnail, url },
    create: {
      videoId,
      url,
      title: meta.title,
      channel: meta.channel,
      thumbnail: meta.thumbnail,
      transcript: "",
    },
  });

  const job = await prisma.job.create({
    data: { videoId, url, style, status: "pending", episodeId: episode.id },
  });

  after(() => processJob(job.id));

  return Response.json({ jobId: job.id, cached: false });
}
