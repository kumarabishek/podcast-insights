import { getTop } from "@/lib/top";
import { HomeClient } from "./HomeClient";

// ISR: the leaderboard is server-rendered into the initial HTML and
// regenerated at most every 5 minutes — fresh enough for a weekly chart,
// near-zero DB load. The client still refetches after an analysis completes.
export const revalidate = 300;

export default async function Home() {
  let top: Awaited<ReturnType<typeof getTop>> = [];
  try {
    top = await getTop();
  } catch {
    // Leaderboard is non-critical — render the page without it.
  }
  return <HomeClient initialTop={top} />;
}
