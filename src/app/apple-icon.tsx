import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS home-screen icon (PNG). Same mark as the favicon.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        <svg width="180" height="180" viewBox="0 0 180 180">
          <rect width="180" height="180" rx="40" fill="#0a0a0a" />
          <path d="M72 52 L132 90 L72 128 Z" fill="#ffffff" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
