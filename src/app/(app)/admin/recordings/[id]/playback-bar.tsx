"use client";
import { fmtMs as fmt } from "./keystroke-timeline";

/** Speeds offered where the player can do them (video and web-app replays). */
export const SPEEDS = [1, 2, 4, 8] as const;

/**
 * The control bar under every recording, whatever the session was (RDP, VNC,
 * SSH, isolated browser, web app), so a reviewer finds the same controls in the
 * same place: play/pause, a seek bar that shades what is loaded, the clock, and
 * where the player supports them speed and full screen.
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
}) {
  const { ready, playing, buffering, position, total } = props;
  const playedPct = total > 0 ? Math.min(100, (position / total) * 100) : 0;
  const loadedPct = props.loadedPct ?? 100;
  return (
    <div className="rec-controls">
      <button type="button" className="btn sm rec-play" onClick={props.onToggle} disabled={!ready}>
        {!ready ? "Loading…" : buffering ? "Buffering…" : playing ? "Pause" : "Play"}
      </button>
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
      <span className="cell-sub rec-time">
        {fmt(position)} / {fmt(total)}
        {props.note ? ` · ${props.note}` : ""}
      </span>
      {props.onSpeed ? (
        <select
          className="input sm rec-speed"
          aria-label="Playback speed"
          value={props.speed ?? 1}
          onChange={(e) => props.onSpeed?.(Number(e.target.value))}
          disabled={!ready}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
      ) : null}
      {props.onFullscreen ? (
        <button type="button" className="btn sm rec-full" onClick={props.onFullscreen} disabled={!ready} aria-label="Full screen" title="Full screen">
          ⛶
        </button>
      ) : null}
    </div>
  );
}

/** Full screen for a player's stage, where the browser allows it. */
export function toggleFullscreen(el: HTMLElement | null) {
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void el.requestFullscreen?.().catch(() => {});
}

/**
 * Space plays and pauses, the arrow keys step 5 seconds, while the player has
 * focus (not while typing in the timeline's search box).
 */
export function playerKeys(e: React.KeyboardEvent, toggle: () => void, seekBy: (ms: number) => void) {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") return;
  if (t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
  if (e.key === " ") {
    e.preventDefault();
    toggle();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    seekBy(5000);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    seekBy(-5000);
  }
}
