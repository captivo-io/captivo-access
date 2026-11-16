"use client";

import { useEffect, useState } from "react";

// The remote-desktop counterpart of the web-app watermark (dataplane
// watermarkScript) and KasmVNC's: the vendor's identity and a live UTC clock,
// tiled over the session, mid-grey at about a third so it reads on light and
// dark screens alike. Laid over the page (pointer-events: none), not drawn into
// the remote picture: a deterrent and attribution in any screenshot or photo.
function tile(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'>` +
    `<text x='20' y='120' transform='rotate(-24 210 110)' font-family='system-ui,sans-serif' font-size='18' font-weight='600' fill='#808080'>${esc}</text></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

function stamp(who: string, now: Date): string {
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${who}  ·  ${now.toISOString().slice(0, 10)} ${hh}:${mm} UTC`;
}

export function SessionWatermark({ text }: { text: string | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!text) return;
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [text]);
  if (!text) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="session-watermark"
      style={{ position: "fixed", inset: 0, zIndex: 29, pointerEvents: "none", opacity: 0.3, backgroundImage: tile(stamp(text, now)) }}
    />
  );
}
