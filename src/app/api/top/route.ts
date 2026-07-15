import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/top — the 5 most-analyzed episodes in the last 7 days.
 * Ranked by DISTINCT IPs per video, so one viewer re-submitting a video
 * (free cache hits included) counts once and can't game the leaderboard.
 */
export async function GET() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const jobs = await prisma.job.findMany({
    where: { createdAt: { gte: weekAgo }, status: "done" },
    select: { videoId: true, ip: true },
  });

  const ipsByVideo = new Map<string, Set<string>>();
  for (const j of jobs) {
    const ips = ipsByVideo.get(j.videoId) ?? new Set<string>();
    ips.add(j.ip ?? "unknown"); // jobs without an IP collapse into one viewer
    ipsByVideo.set(j.videoId, ips);
  }
  const groups = [...ipsByVideo.entries()]
    .map(([videoId, ips]) => ({ videoId, count: ips.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

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
        count: g.count,
      };
    })
    .filter(Boolean);

  return Response.json({ top });
}
