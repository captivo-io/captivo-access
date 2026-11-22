"use client";
import { fmtMs as fmt } from "./keystroke-timeline";

/** Speeds offered where the player can do them (video and web-app replays). */
export const SPEEDS = [0.5, 1, 2, 4, 8] as const;

/** A moment on the seek bar (design hand-off 7.10): typed command, file, navigation… */
export interface Marker { atMs: number; tone: string; label: string }

/**
 * What the recording page gives a player beyond the recording itself: where to
 * start, a way to be told where it is, a handle to seek it from outside (the
 * event list), the markers for its bar, and an overlay drawn over the stage
 * (it must sit inside the player so full screen keeps it).
 */
export interface PlayerShell {
  startMs?: number;
  onState?: (s: { position: number; total: number; playing: boolean; ready: boolean; speed: number }) => void;
  control?: { current: { seek: (ms: number, play?: boolean) => void } | null };
  markers?: Marker[];
  overlay?: React.ReactNode;
  wide?: boolean;
  onWide?: () => void;
  /** Moments only the player can see in the recording (a web app's page loads, a native SSH session's marks). */
  onFound?: (found: { atMs: number; kind: "nav" | "mark"; text: string }[]) => void;
}

/**
 * The control bar under every recording, whatever the session was (RDP, VNC,
 * SSH, isolated browser, web app), so a reviewer finds the same controls in the
 * same place: play/pause, ten seconds back and on, a seek bar that shades what
 * is loaded and marks the session's events, the clock, and where the player
 * supports them speed, wide view and full screen.
 */
export function PlaybackBar(props: {
  ready: boolean;
  playing: boolean;
  buffering?: boolean;
  position: number;
  total: number;
  /** How much of the bar is loaded, 0-100; omitted when all of it is. */
  loadedPct?: number;
  /** Shown after the clock, e.g. "loading". */
  note?: string;
  onToggle: () => void;
  onSeek: (ms: number) => void;
  speed?: number;
  onSpeed?: (speed: number) => void;
  onFullscreen?: () => void;
  markers?: Marker[];
  wide?: boolean;
  onWide?: () => void;
}) {
  const { ready, playing, buffering, position, total } = props;
  const playedPct = total > 0 ? Math.min(100, (position / total) * 100) : 0;
  const loadedPct = props.loadedPct ?? 100;
  const label = !ready ? "Loading…" : buffering ? "Buffering…" : playing ? "Pause" : "Play";
  return (
    <div className="rec-controls">
      <button type="button" className={`rec-play${playing && !buffering ? " on" : ""}`} onClick={props.onToggle} disabled={!ready} aria-label={label} title={label}>
        {!ready || buffering ? <span className="rec-spin" aria-hidden="true" /> : playing ? <PauseIcon /> : <PlayIcon />}
        <span className="sr-only">{label}</span>
      </button>
      <button type="button" className="rec-skip" onClick={() => props.onSeek(Math.max(0, position - 10_000))} disabled={!ready} aria-label="Back 10 seconds">−10</button>
      <button type="button" className="rec-skip" onClick={() => props.onSeek(Math.min(total, position + 10_000))} disabled={!ready} aria-label="Forward 10 seconds">+10</button>
      <div className="rec-track">
        {total > 0 && props.markers?.map((m, i) => (
          <span key={i} className={`rec-mark ${m.tone}`} style={{ left: `${Math.min(100, (m.atMs / total) * 100)}%` }} title={`${fmt(m.atMs)} · ${m.label}`} />
        ))}
        <input
          type="range"
          className="rec-seek"
          min={0}
          max={total || 0}
          value={Math.min(position, total)}
          onChange={(e) => props.onSeek(Number(e.target.value))}
          aria-label="Seek"
          disabled={!ready}
          style={{ ["--played" as string]: `${playedPct}%`, ["--loaded" as string]: `${Math.max(loadedPct, playedPct)}%` }}
        />
      </div>
      <span className="rec-time">
        {fmt(position)} / {fmt(total)}
        {props.note ? ` · ${props.note}` : ""}
      </span>
      {props.onSpeed ? (
        <div className="seg rec-speed" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" data-speed={s} className={(props.speed ?? 1) === s ? "seg-opt on" : "seg-opt"} aria-pressed={(props.speed ?? 1) === s} disabled={!ready} onClick={() => props.onSpeed?.(s)}>
              {s}×
            </button>
          ))}
        </div>
      ) : null}
      {props.onWide ? (
        <button type="button" className={props.wide ? "rec-icon on" : "rec-icon"} onClick={props.onWide} aria-pressed={!!props.wide} aria-label="Wide view" title="Wide view">⤢</button>
      ) : null}
      {props.onFullscreen ? (
        <button type="button" className="rec-icon rec-full" onClick={props.onFullscreen} disabled={!ready} aria-label="Full screen" title="Full screen">⛶</button>
      ) : null}
    </div>
  );
}

function PlayIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>;
}
function PauseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>;
}

/** Full screen for a player's stage, where the browser allows it. */
export function toggleFullscreen(el: HTMLElement | null) {
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void el.requestFullscreen?.().catch(() => {});
}

/**
 * Space plays and pauses, the arrow keys step 5 seconds and J / L ten, and 1-4
 * pick a speed, while the player has focus (not while typing in a search box).
 */
export function playerKeys(e: React.KeyboardEvent, toggle: () => void, seekBy: (ms: number) => void, setSpeed?: (s: number) => void) {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") return;
  if (t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const step: Record<string, number> = { ArrowRight: 5000, ArrowLeft: -5000, l: 10_000, L: 10_000, j: -10_000, J: -10_000 };
  if (e.key === " ") {
    e.preventDefault();
    toggle();
  } else if (step[e.key]) {
    e.preventDefault();
    seekBy(step[e.key]);
  } else if (setSpeed && /^[1-4]$/.test(e.key)) {
    e.preventDefault();
    setSpeed([0.5, 1, 2, 4][Number(e.key) - 1]);
  }
}
