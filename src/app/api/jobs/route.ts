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

// Max NEW (non-cached) analyses per IP per rolling 24h. Cache hits are free
// and never count. Override with DAILY_IP_LIMIT.
const DAILY_IP_LIMIT = Number(process.env.DAILY_IP_LIMIT ?? 3);

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

  const ip = clientIp(request);

  const url = body.url?.trim();
  if (!url) return Response.json({ error: "Missing 'url'." }, { status: 400 });

  const style = isStyleId(body.style) ? body.style : DEFAULT_STYLE;

  const videoId = parseVideoId(url);
  if (!videoId) return Response.json({ error: "Could not parse a YouTube video ID from that URL." }, { status: 400 });

  // Cache hit: this video already analyzed at this style → return a done job.
  // Free, so it bypasses the rate limit and is recorded as cached.
  const existing = await prisma.episode.findUnique({ where: { videoId } });
  if (existing && parseInsightsMap(existing.insights)[style]) {
    const job = await prisma.job.create({
      data: { videoId, url, style, status: "done", episodeId: existing.id, cached: true, ip },
    });
    return Response.json({ jobId: job.id, cached: true });
  }

  // Rate limit: cap NEW analyses per IP per rolling 24h (cache hits excluded).
  if (ip && DAILY_IP_LIMIT > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const used = await prisma.job.count({
      where: { ip, cached: false, createdAt: { gte: since } },
    });
    if (used >= DAILY_IP_LIMIT) {
      return Response.json(
        {
          error: `You've reached the daily limit of ${DAILY_IP_LIMIT} new analyses. Please try again tomorrow. (Already-analyzed episodes are still free.)`,
        },
        { status: 429 },
      );
    }
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
    data: { videoId, url, style, status: "pending", episodeId: episode.id, cached: false, ip },
  });

  after(() => processJob(job.id));

  return Response.json({ jobId: job.id, cached: false });
}
