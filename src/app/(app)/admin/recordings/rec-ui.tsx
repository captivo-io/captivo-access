"use client";

// Shared by the Recordings list and the player page (design hand-off 7.10).

export { protocolLabel, downloadable, clockOf, spanOf, humanBytes, initials, fileNameFor, type RecordingLike } from "@/lib/recording/format";

/** A console link to the recording at a second; it needs a signed-in admin to open. */
export async function copyRecordingLink(id: string, atSec?: number): Promise<boolean> {
  const url = `${location.origin}/admin/recordings/${id}${atSec ? `?t=${Math.floor(atSec)}` : ""}`;
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/** Ask for erasure; the connector removes the bytes and the row goes when it confirms. */
export async function requestErasure(ids: string[]): Promise<number> {
  const done = await Promise.all(ids.map((id) => fetch(`/api/admin/recordings/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.ok).catch(() => false)));
  return done.filter(Boolean).length;
}

const PIECE = 1 << 20;

/**
 * Save a recording's video. It is fetched in the same ranged pieces the player
 * streams with (the proven path through the connector's tunnel), put together
 * in the browser and saved. The download is written to the admin audit chain first.
 */
export async function downloadRecording(id: string, fileName: string, onProgress?: (pct: number) => void): Promise<boolean> {
  const logged = await fetch(`/api/admin/recordings/${encodeURIComponent(id)}/download`, { method: "POST" }).then((r) => r.ok).catch(() => false);
  if (!logged) return false;
  const parts: Blob[] = [];
  let from = 0;
  let total = Infinity;
  while (from < total) {
    const res = await fetch(`/api/admin/recordings/${encodeURIComponent(id)}/video`, { headers: { Range: `bytes=${from}-${from + PIECE - 1}` } }).catch(() => null);
    if (!res || (res.status !== 206 && res.status !== 200)) return false;
    const blob = await res.blob();
    if (res.status === 200) { parts.push(blob); break; }
    const m = /\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "");
    if (m) total = Number(m[1]);
    if (blob.size === 0) return false;
    parts.push(blob);
    from += blob.size;
    if (Number.isFinite(total)) onProgress?.(Math.min(100, Math.round((from / total) * 100)));
  }
  const url = URL.createObjectURL(new Blob(parts, { type: "video/webm" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** The thumbnail art per kind: abstract, never a picture of the session. */
export function Thumb({ kind }: { kind: "web" | "rdp" | "ssh" | "sql" }) {
  if (kind === "sql") {
    return (
      <span className="rc-art sql" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => <span key={i} className={i === 0 ? "h" : undefined}><b /><b /><b /></span>)}
      </span>
    );
  }
  if (kind === "web") {
    return (
      <span className="rc-art web" aria-hidden="true">
        <span className="rc-chrome"><i /><i /><i /><b /></span>
        <span className="rc-page"><span className="rc-side" /><span className="rc-content"><b /><span className="rc-box" /><b className="s" /></span></span>
      </span>
    );
  }
  if (kind === "ssh") {
    return (
      <span className="rc-art ssh" aria-hidden="true">
        {[62, 88, 40, 74, 52, 30].map((w, i) => <b key={i} className={i % 2 ? "o" : "c"} style={{ width: `${w}%` }} />)}
      </span>
    );
  }
  return (
    <span className="rc-art rdp" aria-hidden="true">
      <span className="rc-icons"><i /><i /><i /><i /></span>
      <span className="rc-win"><b /><b className="s" /></span>
      <span className="rc-bar"><i className="on" /><i /><i /><i /><i /></span>
    </span>
  );
}
