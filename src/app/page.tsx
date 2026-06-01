"use client";

import { useCallback, useRef, useState } from "react";
import { STYLES, DEFAULT_STYLE, type StyleId } from "@/lib/styles";

type Insight = { title: string; detail: string };
type Episode = {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  insights: { summary: string; insights: Insight[] } | null;
};
type JobResponse = {
  id: string;
  status: "pending" | "processing" | "done" | "error" | "needs_audio" | "rate_limited";
  error: string | null;
  episode: Episode | null;
};

const STATUS_LABEL: Record<JobResponse["status"], string> = {
  pending: "Queued…",
  processing: "Fetching captions & analyzing…",
  done: "Done",
  error: "Error",
  needs_audio: "No captions available",
  rate_limited: "Daily limit reached",
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [style, setStyle] = useState<StyleId>(DEFAULT_STYLE);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback((jobId: string) => {
    const tick = async () => {
      const res = await fetch(`/api/jobs/${jobId}`);
      const data: JobResponse = await res.json();
      setJob(data);
      if (data.status === "pending" || data.status === "processing") {
        pollRef.current = setTimeout(tick, 2000);
      }
    };
    tick();
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (pollRef.current) clearTimeout(pollRef.current);
      setError(null);
      setJob(null);
      setSubmitting(true);
      try {
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, style }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Something went wrong.");
          return;
        }
        poll(data.jobId);
      } catch {
        setError("Network error. Please try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [url, style, poll],
  );

  const insights = job?.episode?.insights;
  const busy = job?.status === "pending" || job?.status === "processing";

  return (
    <main className="mx-auto max-w-2xl px-5 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Podcast Insights Extractor</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Paste a YouTube podcast link to get the key takeaways.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex gap-2">
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={submitting || busy}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {submitting ? "…" : "Analyze"}
        </button>
      </form>

      <fieldset className="mt-4">
        <legend className="sr-only">Depth</legend>
        <div className="grid grid-cols-3 gap-2">
          {STYLES.map((s) => {
            const active = style === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStyle(s.id)}
                aria-pressed={active}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  active
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-black"
                    : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
                }`}
              >
                <span className="block text-sm font-medium">{s.label}</span>
                <span
                  className={`block text-xs ${active ? "opacity-80" : "text-neutral-500"}`}
                >
                  {s.tagline}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {job && (
        <section className="mt-8">
          {job.episode && (
            <header className="flex items-start gap-3">
              {job.episode.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={job.episode.thumbnail}
                  alt=""
                  className="h-16 w-28 rounded object-cover"
                />
              )}
              <div>
                <h2 className="font-semibold leading-snug">{job.episode.title}</h2>
                <p className="text-sm text-neutral-500">{job.episode.channel}</p>
              </div>
            </header>
          )}

          {busy && (
            <p className="mt-6 animate-pulse text-sm text-neutral-500">
              {STATUS_LABEL[job.status]}
            </p>
          )}

          {job.status === "needs_audio" && (
            <p className="mt-6 text-sm text-amber-600">
              This video has captions disabled, so it can&apos;t be analyzed yet.
            </p>
          )}
          {job.status === "rate_limited" && (
            <p className="mt-6 text-sm text-amber-600">
              We&apos;ve hit today&apos;s free analysis limit. Please try again later — your
              progress on this episode is saved, so it&apos;ll be quick next time.
            </p>
          )}
          {job.status === "error" && (
            <p className="mt-6 text-sm text-red-600">Error: {job.error}</p>
          )}

          {insights && (
            <div className="mt-6">
              <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
                {insights.summary}
              </p>
              <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Key insights
              </h3>
              <ol className="mt-3 space-y-4">
                {insights.insights.map((ins, i) => (
                  <li key={i} className="border-l-2 border-neutral-200 pl-4 dark:border-neutral-800">
                    <p className="font-medium">{ins.title}</p>
                    <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                      {ins.detail}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
