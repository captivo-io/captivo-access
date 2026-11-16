"use client";
import { useEffect, useState } from "react";

export type KeystrokeEvent = { atMs: number; kind: string; text: string; masked: boolean };

/**
 * The typed-input timeline under a recording, the same for every kind of
 * session: gateway (SSH commands, RDP/VNC text), web app (field values) and
 * isolated browser. Click an entry to jump the player to that moment. Renders
 * nothing when the recording has no keystroke stream.
 */
export function KeystrokeTimeline({ recordingId, onJump, disabled }: { recordingId: string; onJump: (atMs: number) => void; disabled?: boolean }) {
  const [events, setEvents] = useState<KeystrokeEvent[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch(`/api/admin/recordings/${recordingId}/keyevents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((e) => setEvents(Array.isArray(e) ? e : []))
      .catch(() => {});
  }, [recordingId]);

  if (events.length === 0) return null;
  const shown = events.filter((e) => !q || e.text.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-head"><div className="ch-title"><h2>Timeline</h2><span className="sub">Typed input — click to jump</span></div></div>
      <input className="input" placeholder="Search typed input…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
      <div style={{ maxHeight: "18rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {shown.map((e, i) => (
          <button key={i} type="button" className="scp-item" style={{ display: "flex", gap: 10, alignItems: "baseline", width: "100%", textAlign: "left" }} onClick={() => onJump(e.atMs)} disabled={disabled}>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "#94a3b8", flexShrink: 0 }}>{fmtMs(e.atMs)}</span>
            <span style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
