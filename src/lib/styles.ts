// Client-safe style metadata (no prompt text — prompts live server-side in
// insights.ts so they don't ship in the browser bundle).

export const STYLES = [
  { id: "A", label: "Actionable", tagline: "Practical takeaways you can apply" },
  { id: "B", label: "In-depth", tagline: "Full substance — arguments & nuance" },
  { id: "C", label: "Briefing", tagline: "Fast, scannable recap" },
] as const;

export type StyleId = (typeof STYLES)[number]["id"];

export const DEFAULT_STYLE: StyleId = "A";

export function isStyleId(v: unknown): v is StyleId {
  return typeof v === "string" && STYLES.some((s) => s.id === v);
}
