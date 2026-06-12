import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function fmt(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export default async function AdminPage() {
  const [feedback, episodeCount, jobCount] = await Promise.all([
    prisma.feedback.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.episode.count(),
    prisma.job.count(),
  ]);

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl px-5 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Admin · Feedback</h1>
      <p className="mt-2 text-sm text-neutral-500">
        {episodeCount} episodes · {jobCount} analyses · {feedback.length} feedback
        {feedback.length === 200 ? "+ (showing latest 200)" : ""}
      </p>

      {feedback.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">No feedback yet.</p>
      ) : (
        <ul className="mt-8 space-y-4">
          {feedback.map((f) => (
            <li
              key={f.id}
              className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{f.message}</p>
              <p className="mt-2 text-xs text-neutral-500">
                {f.email ? <span>{f.email} · </span> : null}
                {fmt(f.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
