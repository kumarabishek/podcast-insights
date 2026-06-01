import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { parseInsightsMap } from "@/lib/insights";
import { isStyleId } from "@/lib/styles";

/**
 * GET /api/jobs/:id — poll job status; returns insights when done.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return Response.json({ error: "Job not found." }, { status: 404 });

  const episode = job.episodeId
    ? await prisma.episode.findUnique({ where: { id: job.episodeId } })
    : null;

  const style = isStyleId(job.style) ? job.style : "A";

  return Response.json({
    id: job.id,
    status: job.status,
    style,
    error: job.error,
    episode: episode
      ? {
          videoId: episode.videoId,
          url: episode.url,
          title: episode.title,
          channel: episode.channel,
          thumbnail: episode.thumbnail,
          insights: parseInsightsMap(episode.insights)[style] ?? null,
        }
      : null,
  });
}
