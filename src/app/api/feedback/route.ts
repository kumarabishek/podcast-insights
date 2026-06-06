import { prisma } from "@/lib/db";

/**
 * POST /api/feedback — store user feedback.
 */
export async function POST(request: Request) {
  let body: { message?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) return Response.json({ error: "Message is required." }, { status: 400 });
  if (message.length > 2000) return Response.json({ error: "Message is too long." }, { status: 400 });

  const email =
    typeof body.email === "string" && body.email.trim() ? body.email.trim().slice(0, 200) : null;

  await prisma.feedback.create({ data: { message: message.slice(0, 2000), email } });
  return Response.json({ ok: true });
}
