import { prisma } from "./db";
import { fetchCaptions } from "./captions";
import { extractInsights, parseInsightsMap, isRateLimitError } from "./insights";
import { isStyleId, type StyleId } from "./styles";

/**
 * Process a job: fetch captions, run Claude, persist the Episode.
 * Designed to be called from a route handler via `after()` so it runs
 * after the response is sent. Updates job status as it progresses.
 */
export async function processJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "pending") return;

  await prisma.job.update({ where: { id: jobId }, data: { status: "processing" } });

  const style: StyleId = isStyleId(job.style) ? job.style : "A";

  try {
    const episode = await prisma.episode.findUnique({ where: { videoId: job.videoId } });
    if (!episode) throw new Error("Episode row missing for job");

    // Fetch captions only if we don't already have the transcript (reused
    // across styles — the expensive step runs once per video).
    let transcript = episode.transcript;
    if (!transcript) {
      const captions = await fetchCaptions(job.videoId);
      if (!captions.ok) {
        const status = captions.reason === "no_captions" ? "needs_audio" : "error";
        await prisma.job.update({ where: { id: jobId }, data: { status, error: captions.message } });
        return;
      }
      transcript = captions.text;
      await prisma.episode.update({ where: { videoId: job.videoId }, data: { transcript } });
    }

    const { result, model } = await extractInsights(
      transcript,
      { title: episode.title, channel: episode.channel },
      style,
    );

    // Merge this style's result into the per-style map.
    const map = parseInsightsMap(episode.insights);
    map[style] = result;

    await prisma.episode.update({
      where: { videoId: job.videoId },
      data: { insights: JSON.stringify(map), model },
    });
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "done", episodeId: episode.id, error: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish daily-quota / rate-limit exhaustion so the UI can show a
    // friendly "try again later" instead of a generic error. The transcript
    // is already saved, so a later retry won't re-fetch captions.
    const status = isRateLimitError(err) ? "rate_limited" : "error";
    await prisma.job.update({ where: { id: jobId }, data: { status, error: message } });
  }
}
