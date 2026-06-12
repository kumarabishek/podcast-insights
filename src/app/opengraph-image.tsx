import { ImageResponse } from "next/og";

export const alt = "Podcast Insights Extractor";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Social share card (1200×630) generated at build time — no design tools.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "90px",
          background: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <svg width="96" height="96" viewBox="0 0 96 96">
            <rect width="96" height="96" rx="22" fill="#0a0a0a" />
            <path d="M38 28 L72 48 L38 68 Z" fill="#ffffff" />
          </svg>
          <div style={{ fontSize: 30, color: "#737373", fontWeight: 500 }}>
            podcast-insightcribe.vercel.app
          </div>
        </div>

        <div
          style={{
            fontSize: 82,
            fontWeight: 800,
            color: "#0a0a0a",
            marginTop: 48,
            lineHeight: 1.05,
            letterSpacing: -2,
          }}
        >
          Podcast Insights Extractor
        </div>

        <div style={{ fontSize: 38, color: "#525252", marginTop: 28 }}>
          Key takeaways from any YouTube podcast — in seconds.
        </div>
      </div>
    ),
    { ...size },
  );
}
