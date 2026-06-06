export const dynamic = "force-dynamic";

/**
 * Diagnostic: reports which env vars the running deployment can see (booleans
 * only — never the values). Visit /api/health on the live URL.
 */
export async function GET() {
  return Response.json({
    provider: process.env.LLM_PROVIDER ?? (process.env.GEMINI_API_KEY ? "gemini" : "anthropic"),
    hasGemini: !!process.env.GEMINI_API_KEY,
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
    hasSupadata: !!process.env.SUPADATA_API_KEY,
    hasDb: !!(
      process.env.DATABASE_URL ??
      process.env.POSTGRES_PRISMA_URL ??
      process.env.POSTGRES_URL ??
      process.env.DATABASE_URL_UNPOOLED
    ),
  });
}
