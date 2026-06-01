/**
 * YouTube URL parsing + lightweight metadata (no API key required).
 */

/** Extract the 11-char video ID from any common YouTube URL shape. */
export function parseVideoId(input: string): string | null {
  const url = input.trim();

  // Bare ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "");

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    // watch?v=<id>
    const v = parsed.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    // /embed/<id>, /live/<id>, /shorts/<id>, /v/<id>
    const m = parsed.pathname.match(/^\/(embed|live|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[2];
  }

  return null;
}

export type VideoMeta = {
  title: string;
  channel: string;
  thumbnail: string | null;
};

/**
 * Fetch title/channel/thumbnail via YouTube's oEmbed endpoint (no API key).
 * Returns null if the video is private/unavailable.
 */
export async function fetchVideoMeta(videoId: string): Promise<VideoMeta | null> {
  const oembed = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const res = await fetch(oembed, { cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };
  return {
    title: data.title ?? "Untitled",
    channel: data.author_name ?? "Unknown",
    thumbnail: data.thumbnail_url ?? null,
  };
}
