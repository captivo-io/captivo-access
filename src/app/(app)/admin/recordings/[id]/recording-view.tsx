"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { buildTimeline, currentEventIndex, type TimelineEvent } from "@/lib/recording/timeline";
import { recordingType } from "@/lib/recording/filter";
import { fmt, isoWithOffset, useZone } from "../../audit/audit-zone";
import {
  clockOf, copyRecordingLink, downloadRecording, downloadable, fileNameFor, humanBytes, initials, protocolLabel, requestErasure, spanOf,
} from "../rec-ui";
import type { KeystrokeEvent } from "./keystroke-timeline";
import type { Marker, PlayerShell } from "./playback-bar";
import { RecordingPlayer } from "./recording-player";
import { GuacRecordingPlayer } from "./guac-recording-player";
import { VideoRecordingPlayer } from "./video-recording-player";
import { TermRecordingPlayer } from "./term-recording-player";
import { PreparingRecording } from "./preparing-recording";
import { QueryLog } from "./query-log";

export interface RecordingInfo {
  id: string;
  format: string;
  protocol: string | null;
  videoReady: boolean;
  preparing: boolean;
  startedAt: string;
  lengthMs: number;
  measured: boolean;
  bytes: number;
  host: string;
  encrypted: boolean;
  purgePending: boolean;
}

type Clock = { position: number; total: number; playing: boolean; ready: boolean; speed: number };
const MARKER_TONE: Record<string, string> = { nav: "p", file: "violet", command: "ok", text: "warn", muted: "muted" };

/**
 * One recording (design hand-off 7.10): the header with its actions, the
 * replay with a forensic watermark and the shared controls, and a side panel
 * with the session's events (click one to go there) and its details.
 */
export function RecordingView({ rec, user, siteName, workspace, retentionDays, transfers, startMs, notice }: {
  rec: RecordingInfo;
  user: { name: string | null; email: string | null };
  siteName: string;
  workspace: string;
  retentionDays: number;
  transfers: { atMs: number; text: string }[];
  startMs?: number;
  notice?: React.ReactNode;
}) {
  const zone = useZone();
  const router = useRouter();
  const kind = recordingType(rec);
  const empty = rec.measured && rec.lengthMs < 1000;
  const [wide, setWide] = useState(false);
  const sql = rec.format === "SQL";
  const [tab, setTab] = useState<"events" | "details">(sql ? "details" : "events");
  const [clock, setClock] = useState<Clock>({ position: startMs ?? 0, total: rec.lengthMs, playing: false, ready: false, speed: 1 });
  const [keys, setKeys] = useState<KeystrokeEvent[]>([]);
  const [keysState, setKeysState] = useState<"loading" | "ok" | "unreachable">("loading");
  const [navs, setNavs] = useState<{ atMs: number; text: string }[]>([]);
  const [marks, setMarks] = useState<{ atMs: number; text: string }[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const control = useRef<{ seek: (ms: number, play?: boolean) => void } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (empty) return;
    fetch(`/api/admin/recordings/${rec.id}/keyevents`)
      .then(async (r) => {
        if (!r.ok) { setKeysState("unreachable"); return; }
        const e = await r.json();
        setKeys(Array.isArray(e) ? e : []);
        setKeysState("ok");
      })
      .catch(() => setKeysState("unreachable"));
  }, [rec.id, empty]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const total = clock.total || rec.lengthMs;
  const events = useMemo(() => buildTimeline({ totalMs: total, keys, transfers, navs, marks, terminal: kind === "ssh" }), [total, keys, transfers, navs, marks, kind]);
  const markers: Marker[] = useMemo(
    () => events.filter((e) => e.tone !== "muted").map((e) => ({ atMs: e.atMs, tone: MARKER_TONE[e.tone], label: e.command ? `$ ${e.text}` : e.text })),
    [events],
  );
  const current = currentEventIndex(events, clock.position);

  // Keep the current event in view in the list while playing.
  useEffect(() => {
    if (!clock.playing || tab !== "events") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current, clock.playing, tab]);

  const onState = useCallback((s: Clock) => setClock(s), []);
  const onFound = useCallback((found: { atMs: number; kind: "nav" | "mark"; text: string }[]) => {
    setNavs(found.filter((f) => f.kind === "nav"));
    setMarks(found.filter((f) => f.kind === "mark"));
  }, []);
  const name = user.name ?? user.email ?? "Unknown user";
  const wall = Date.parse(rec.startedAt) + clock.position;
  const overlay = (
    <>
      <span className={clock.playing ? "rv-state on" : "rv-state"}>
        <i aria-hidden="true" />{clock.playing ? `Replay · ${clock.speed}×` : "Paused"}
      </span>
      <span className="rv-mark mono" aria-hidden="true">
        {[workspace, user.email ?? name, siteName, fmt(wall, zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })].filter(Boolean).join(" · ")}
      </span>
    </>
  );
  const shell: PlayerShell = { startMs, onState, control, markers, overlay, wide, onWide: () => setWide((w) => !w), onFound };

  async function download() {
    setBusy("Preparing…");
    const ok = await downloadRecording(rec.id, fileNameFor(siteName, rec.startedAt), (p) => setBusy(`Downloading ${p}%`));
    setBusy(null);
    setToast({ msg: ok ? "Download saved" : "The download did not finish. Its connector may be offline.", ok });
  }
  async function erase() {
    if (!confirm) { setConfirm(true); return; }
    setBusy("Requesting…");
    const n = await requestErasure([rec.id]);
    setBusy(null);
    if (n) { router.push("/admin/recordings"); return; }
    setConfirm(false);
    setToast({ msg: "Couldn't request the erasure. Try again.", ok: false });
  }
  function seek(e: TimelineEvent) {
    control.current?.seek(e.atMs, true);
  }

  const deletesOn = retentionDays > 0 ? new Date(Date.parse(rec.startedAt) + retentionDays * 86_400_000).toISOString() : null;

  return (
    <div className={wide ? "rv wide" : "rv"}>
      <Link href="/admin/recordings" className="btn sm rc-back">← Recordings</Link>
      <div className="page-head rv-head">
        <div>
          <div className="rv-title"><span className={kind === "rdp" ? "rv-chip remote" : "rv-chip"}>{protocolLabel(rec)}</span><h1>{siteName}</h1></div>
          <div className="rv-meta">
            <span className="rc-user"><span className="au-av sm" aria-hidden="true">{initials(name)}</span>{name}</span>
            <span>{fmt(rec.startedAt, zone, { day: "numeric", month: "short", year: "numeric" })} · {fmt(rec.startedAt, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            <span className="mono">{spanOf(rec.lengthMs)}</span>
            <span className="mono">{humanBytes(rec.bytes)}</span>
          </div>
        </div>
        <div className="row-actions">
          {downloadable(rec) && <button type="button" className="btn" onClick={download} disabled={!!busy}>{busy && busy !== "Requesting…" ? busy : "Download"}</button>}
          <button type="button" className="btn" onClick={async () => { const ok = await copyRecordingLink(rec.id, clock.position / 1000); setToast({ msg: ok ? `Link copied at ${clockOf(clock.position)}. It opens for signed-in admins.` : "Couldn't copy the link", ok }); }}>Copy link</button>
          {!rec.purgePending && (
            <button type="button" className={confirm ? "btn danger rv-del on" : "btn danger rv-del"} onClick={erase} disabled={busy === "Requesting…"}>
              {busy === "Requesting…" ? busy : confirm ? "Sure? Request erasure" : "Request erasure"}
            </button>
          )}
        </div>
      </div>
      {notice}
      {rec.purgePending ? <p className="notice warn" role="status">Erasure was requested. The recording is removed when its connector confirms; until then it can still be played.</p> : null}

      <div className="rv-grid">
        <div className="rv-stage">
          {sql ? (
            <QueryLog events={keys} state={keysState} startedAt={rec.startedAt} />
          ) : empty ? (
            <div className="rv-empty">
              <b>Empty session</b>
              <span>The connection closed at once. There is nothing to replay.</span>
            </div>
          ) : rec.format === "VIDEO" || ((rec.format === "GUAC" || rec.format === "RDP") && rec.videoReady) ? (
            <VideoRecordingPlayer id={rec.id} durationMs={rec.lengthMs} shell={shell} />
          ) : rec.preparing ? (
            <PreparingRecording id={rec.id} estimatedMs={rec.lengthMs} shell={shell} />
          ) : rec.format === "RDP" ? (
            <div className="rv-empty">
              <b>No video of this session</b>
              <span>Its connector could not turn the recording into video. The recording is kept on the connector; ask your administrator to check the connector&apos;s logs.</span>
            </div>
          ) : rec.format === "GUAC" ? (
            <GuacRecordingPlayer recordingId={rec.id} estimatedMs={rec.lengthMs} shell={shell} />
          ) : rec.format === "TERM" ? (
            <TermRecordingPlayer id={rec.id} shell={shell} />
          ) : (
            <RecordingPlayer id={rec.id} shell={shell} />
          )}
        </div>

        {!wide && (
          <aside className="rv-side">
            <div className="rv-tabs" role="tablist">
              {!sql && <button type="button" role="tab" aria-selected={tab === "events"} className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>Events</button>}
              <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "on" : ""} onClick={() => setTab("details")}>Details</button>
            </div>
            {tab === "events" ? (
              <>
                <ol className="rv-events" ref={listRef}>
                  {events.map((e, i) => (
                    <li key={i} data-i={i}>
                      <button type="button" className={`rv-ev ${i === current ? "cur" : i < current ? "past" : ""}`} onClick={() => seek(e)} disabled={empty}>
                        <span className="mono rv-t">{clockOf(e.atMs)}</span>
                        <span className={`rv-dot ${e.tone}`} aria-hidden="true" />
                        <span className={e.command || e.tone === "text" ? "mono rv-x" : "rv-x"}>{e.command ? `$ ${e.text}` : e.text}</span>
                      </button>
                    </li>
                  ))}
                </ol>
                {keysState === "loading" && !empty ? <p className="rv-note">Reading the typed input from the connector…</p> : null}
                {keysState === "unreachable" ? <p className="rv-note">Typed input could not be read: its connector is offline. The other events are shown.</p> : null}
                {keysState === "ok" && keys.length === 0 && !empty ? <p className="rv-note">No typed input was recorded for this session (keystroke logging is off for this resource, or nothing was typed).</p> : null}
              </>
            ) : (
              <dl className="au-dl rv-details">
                {([
                  ["User", <>{name}{user.email && user.name ? <div className="cell-sub">{user.email}</div> : null}</>],
                  ["Resource", siteName],
                  ["Host", <span key="h" className="mono">{rec.host}</span>],
                  ["Protocol", protocolLabel(rec)],
                  ["Started", <span key="s" className="mono">{isoWithOffset(rec.startedAt, zone)}</span>],
                  ["Length", <span key="l" className="mono">{clockOf(rec.lengthMs)}{rec.measured ? "" : " (estimated)"}</span>],
                  ["Size", <span key="z" className="mono">{humanBytes(rec.bytes)}</span>],
                  ["Recording", <span key="i" className="mono cell-sub">{rec.id}</span>],
                ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            )}
            {tab === "details" && (
              <div className="rv-facts">
                <div className="rv-fact ok">
                  <b>{rec.encrypted ? "Encrypted at rest on your connector" : "Stored on your connector"}</b>
                  <span>The recording stays on the customer&apos;s host and streams here through the connector&apos;s tunnel to play.</span>
                </div>
                <p className="rv-note">{deletesOn ? `Removed automatically on ${fmt(deletesOn, zone, { day: "numeric", month: "long", year: "numeric" })} (${retentionDays}-day retention).` : "Kept until erased: no retention period is set."}</p>
              </div>
            )}
          </aside>
        )}
      </div>
      {toast && <div className={toast.ok ? "toast" : "toast warn"} role="status"><span aria-hidden="true">{toast.ok ? "✓" : "!"}</span> {toast.msg}</div>}
    </div>
  );
}
