import { getTop } from "@/lib/top";

export const dynamic = "force-dynamic";

/**
 * GET /api/top — the weekly leaderboard, for client-side refresh after an
 * analysis completes. Initial page load gets the same data server-rendered.
 */
export async function GET() {
  return Response.json({ top: await getTop() });
}
