import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/top — the 5 most-analyzed episodes in the last 7 days.
 */
export async function GET() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const groups = await prisma.job.groupBy({
    by: ["videoId"],
    where: { createdAt: { gte: weekAgo }, status: "done" },
    _count: { videoId: true },
    orderBy: { _count: { videoId: "desc" } },
    take: 5,
  });

  const videoIds = groups.map((g) => g.videoId);
  const episodes = await prisma.episode.findMany({ where: { videoId: { in: videoIds } } });
  const byId = new Map(episodes.map((e) => [e.videoId, e]));

  const top = groups
    .map((g) => {
      const e = byId.get(g.videoId);
      if (!e) return null;
      return {
        videoId: g.videoId,
        url: e.url,
        title: e.title,
        channel: e.channel,
        thumbnail: e.thumbnail,
        count: g._count.videoId,
      };
    })
    .filter(Boolean);

  return Response.json({ top });
}
