import { prisma } from "@/lib/db";
import { parseVideoId } from "@/lib/youtube";
import { answerQuestion } from "@/lib/insights";
import { verifyTurnstile, clientIp } from "@/lib/turnstile";

export const maxDuration = 60;

/**
 * POST /api/ask — answer a question about an already-analyzed episode,
 * grounded in its transcript, with a "jump to" timestamp when possible.
 */
export async function POST(request: Request) {
  let body: { videoId?: string; url?: string; question?: string; turnstileToken?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const human = await verifyTurnstile(body.turnstileToken, clientIp(request));
  if (!human) {
    return Response.json({ error: "Verification failed. Please try again." }, { status: 403 });
  }

  const question = body.question?.trim();
  if (!question) return Response.json({ error: "Question is required." }, { status: 400 });
  if (question.length > 500) return Response.json({ error: "Question is too long." }, { status: 400 });

  const videoId = body.videoId?.trim() || (body.url ? parseVideoId(body.url) : null);
  if (!videoId) return Response.json({ error: "Missing video." }, { status: 400 });

  const episode = await prisma.episode.findUnique({ where: { videoId } });
  if (!episode || !episode.transcript) {
    return Response.json({ error: "Analyze this video first, then ask about it." }, { status: 400 });
  }

  try {
    const { result } = await answerQuestion(
      episode.transcript,
      { title: episode.title, channel: episode.channel },
      question,
    );
    return Response.json({ answer: result.answer, startTime: result.startTime, videoId });
  } catch {
    return Response.json(
      { error: "Couldn't answer right now. Please try again." },
      { status: 502 },
    );
  }
}
