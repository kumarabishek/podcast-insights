"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@vercel/analytics";
import { STYLES, DEFAULT_STYLE, type StyleId } from "@/lib/styles";
import { TurnstileWidget } from "./TurnstileWidget";

type Insight = { title: string; detail: string; startTime?: number };

function fmtTime(s: number): string {
  const sec = Math.max(0, Math.floor(s));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
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
type TopItem = {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  count: number;
};

const STATUS_LABEL: Record<JobResponse["status"], string> = {
  pending: "Queued…",
  processing: "Fetching captions & analyzing…",
  done: "Done",
  error: "Error",
  needs_audio: "No captions available",
  rate_limited: "Daily limit reached",
};

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export default function Home() {
  const [url, setUrl] = useState("");
  const [style, setStyle] = useState<StyleId>(DEFAULT_STYLE);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [top, setTop] = useState<TopItem[]>([]);
  const [openInsights, setOpenInsights] = useState<Set<number>>(new Set());
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; startTime: number | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleInsight = (i: number) =>
    setOpenInsights((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  // Turnstile token (only meaningful when a site key is configured).
  const [token, setToken] = useState("");
  const [tokenNonce, setTokenNonce] = useState(0);
  const onToken = useCallback((t: string) => setToken(t), []);

  const loadTop = useCallback(async () => {
    try {
      const res = await fetch("/api/top");
      const data = await res.json();
      setTop(data.top ?? []);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    loadTop();
  }, [loadTop]);

  const poll = useCallback(
    (jobId: string) => {
      const tick = async () => {
        const res = await fetch(`/api/jobs/${jobId}`);
        const data: JobResponse = await res.json();
        setJob(data);
        if (data.status === "pending" || data.status === "processing") {
          pollRef.current = setTimeout(tick, 2000);
        } else if (data.status === "done") {
          track("analysis_completed", { style });
          loadTop(); // refresh the weekly leaderboard
        } else {
          track("analysis_failed", { reason: data.status });
        }
      };
      tick();
    },
    [loadTop, style],
  );

  const analyze = useCallback(
    async (targetUrl: string, source: "manual" | "leaderboard" = "manual") => {
      if (pollRef.current) clearTimeout(pollRef.current);
      setError(null);
      setJob(null);
      setOpenInsights(new Set());
      setQuestion("");
      setAnswer(null);
      setAskError(null);
      setSubmitting(true);
      try {
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl, style, turnstileToken: token }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Something went wrong.");
          return;
        }
        track("analysis_submitted", { style, source });
        poll(data.jobId);
      } catch {
        setError("Network error. Please try again.");
      } finally {
        setSubmitting(false);
        // Refresh the Turnstile token so the next analysis has a fresh one.
        if (TURNSTILE_SITE_KEY) {
          setToken("");
          setTokenNonce((n) => n + 1);
        }
      }
    },
    [style, token, poll],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      analyze(url);
    },
    [analyze, url],
  );

  const ask = useCallback(async () => {
    const q = question.trim();
    const vid = job?.episode?.videoId;
    if (!q || !vid) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: vid, question: q, turnstileToken: token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAskError(data.error ?? "Something went wrong.");
        return;
      }
      setAnswer({ answer: data.answer, startTime: data.startTime ?? null });
      track("question_asked");
    } catch {
      setAskError("Network error. Please try again.");
    } finally {
      setAsking(false);
      if (TURNSTILE_SITE_KEY) {
        setToken("");
        setTokenNonce((n) => n + 1);
      }
    }
  }, [question, job, token]);

  const insights = job?.episode?.insights;
  const busy = job?.status === "pending" || job?.status === "processing";
  const needsToken = !!TURNSTILE_SITE_KEY && !token;

  return (
    <main className={`mx-auto w-full min-w-0 max-w-2xl px-5 py-12 ${insights ? "pb-40" : ""}`}>
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
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={submitting || busy || needsToken}
          className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
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
                <span className={`block text-xs ${active ? "opacity-80" : "text-neutral-500"}`}>
                  {s.tagline}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {TURNSTILE_SITE_KEY && (
        <TurnstileWidget key={tokenNonce} siteKey={TURNSTILE_SITE_KEY} onToken={onToken} />
      )}

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
                  className="h-16 w-28 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0">
                <h2 className="break-words font-semibold leading-snug">{job.episode.title}</h2>
                <p className="text-sm text-neutral-500">{job.episode.channel}</p>
              </div>
            </header>
          )}

          {busy && (
            <p className="mt-6 animate-pulse text-sm text-neutral-500">{STATUS_LABEL[job.status]}</p>
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
              <p className="break-words text-[15px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                {insights.summary}
              </p>

              <div className="mt-6 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Key insights
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    setOpenInsights((prev) =>
                      prev.size === insights.insights.length
                        ? new Set()
                        : new Set(insights.insights.map((_, i) => i)),
                    )
                  }
                  className="text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                >
                  {openInsights.size === insights.insights.length ? "Collapse all" : "Expand all"}
                </button>
              </div>

              {/* Tappable headlines — expand only what you want to read. */}
              <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
                {insights.insights.map((ins, i) => {
                  const open = openInsights.has(i);
                  const vid = job.episode?.videoId;
                  const hasTime = ins.startTime != null && vid;
                  return (
                    <li key={i}>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => toggleInsight(i)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleInsight(i);
                          }
                        }}
                        className="flex w-full cursor-pointer items-start gap-3 py-3 text-left"
                      >
                        <span className="mt-0.5 w-4 shrink-0 text-sm font-semibold text-neutral-400">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-[15px] font-medium leading-snug">
                          {ins.title}
                        </span>
                        {hasTime && (
                          <a
                            href={`https://www.youtube.com/watch?v=${vid}&t=${Math.floor(ins.startTime!)}s`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Watch this part on YouTube"
                            className="mt-0.5 shrink-0 whitespace-nowrap text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            ▶ {fmtTime(ins.startTime!)}
                          </a>
                        )}
                        <span
                          className={`mt-1 shrink-0 text-neutral-400 transition-transform ${
                            open ? "rotate-180" : ""
                          }`}
                          aria-hidden
                        >
                          ▾
                        </span>
                      </div>
                      {open && (
                        <p className="break-words pb-4 pl-7 pr-2 text-[15px] leading-relaxed text-neutral-600 dark:text-neutral-400">
                          {ins.detail}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Top podcasts this week */}
      {top.length > 0 && (
        <section className="mt-12 border-t border-neutral-200 pt-8 dark:border-neutral-800">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Top podcasts this week
          </h2>
          <ol className="mt-4 space-y-3">
            {top.map((t, i) => (
              <li key={t.videoId}>
                <button
                  type="button"
                  onClick={() => {
                    setUrl(t.url);
                    analyze(t.url, "leaderboard");
                  }}
                  className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  <span className="w-4 text-sm font-semibold text-neutral-400">{i + 1}</span>
                  {t.thumbnail && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.thumbnail} alt="" className="h-10 w-16 rounded object-cover" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t.title}</span>
                    <span className="block truncate text-xs text-neutral-500">{t.channel}</span>
                  </span>
                  <span className="text-xs text-neutral-400">{t.count}×</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Feedback */}
      <FeedbackSection />

      {/* Sticky "Ask about this episode" bar — appears once a result loads */}
      {insights && job?.episode && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/95 backdrop-blur dark:border-neutral-800 dark:bg-black/95"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="mx-auto max-w-2xl px-5">
            {(asking || askError || answer) && (
              <div className="max-h-[40vh] overflow-y-auto border-b border-neutral-100 py-3 dark:border-neutral-900">
                {asking && (
                  <p className="animate-pulse text-sm text-neutral-500">Thinking…</p>
                )}
                {askError && <p className="text-sm text-red-600">{askError}</p>}
                {answer && (
                  <div className="relative pr-6">
                    <button
                      type="button"
                      onClick={() => setAnswer(null)}
                      aria-label="Dismiss answer"
                      className="absolute right-0 top-0 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      ✕
                    </button>
                    <p className="break-words text-[15px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                      {answer.answer}
                    </p>
                    {answer.startTime != null && (
                      <a
                        href={`https://www.youtube.com/watch?v=${job.episode.videoId}&t=${Math.floor(answer.startTime)}s`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        ▶ Jump to {fmtTime(answer.startTime)}
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask();
              }}
              className="flex gap-2 py-3"
            >
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about this episode…"
                maxLength={500}
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                type="submit"
                disabled={asking || needsToken || !question.trim()}
                className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
              >
                {asking ? "…" : "Ask"}
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

function FeedbackSection() {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setState("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, email }),
      });
      setState(res.ok ? "sent" : "error");
      if (res.ok) {
        track("feedback_submitted");
        setMessage("");
        setEmail("");
      }
    } catch {
      setState("error");
    }
  };

  return (
    <section className="mt-12 border-t border-neutral-200 pt-8 dark:border-neutral-800">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Feedback</h2>
      {state === "sent" ? (
        <p className="mt-4 text-sm text-green-600">Thanks for the feedback! 🙏</p>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What do you think? Bugs, ideas, requests…"
            rows={3}
            maxLength={2000}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (optional)"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="submit"
              disabled={state === "sending" || !message.trim()}
              className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {state === "sending" ? "…" : "Send"}
            </button>
          </div>
          {state === "error" && (
            <p className="text-sm text-red-600">Could not send. Please try again.</p>
          )}
        </form>
      )}
    </section>
  );
}
