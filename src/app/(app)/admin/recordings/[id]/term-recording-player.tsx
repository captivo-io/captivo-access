"use client";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { parseAsciicast, parseSize, skipIdle, stateAt, termMarks, type TermRecording } from "@/lib/recording/asciicast";
import { PlaybackBar, playerKeys, toggleFullscreen, type PlayerShell } from "./playback-bar";

/** A quiet stretch longer than this is skipped while playing. */
const IDLE_MS = 3_000;
const TICK_MS = 40;

/**
 * Plays a recorded native SSH session (format TERM): what the terminal showed,
 * at the size it had, in a terminal emulator. Seeking rebuilds the screen from
 * the start, as a terminal's state can only be known that way; playing writes
 * each output at its moment and skips long quiet stretches.
 */
export function TermRecordingPlayer({ id, shell = {} }: { id: string; shell?: PlayerShell }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const recRef = useRef<TermRecording | null>(null);
  const cursor = useRef(0); // next event to write
  const posRef = useRef(0);
  const [rec, setRec] = useState<TermRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const { onState, control, onFound } = shell;

  const redraw = useCallback((ms: number) => {
    const term = termRef.current, r = recRef.current;
    if (!term || !r) return;
    const st = stateAt(r, ms);
    term.reset();
    term.resize(st.cols, st.rows);
    if (st.output) term.write(st.output);
    cursor.current = st.next;
    posRef.current = ms;
    setPosition(ms);
  }, []);

  // Load the recording and the terminal.
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const [res, xterm] = await Promise.all([fetch(`/api/admin/recordings/${id}/term`), import("@xterm/xterm")]);
        if (!res.ok) {
          setError(res.status === 503 ? "This recording's connector is offline. The recording is intact; try again when it is back." : "Couldn't load this recording.");
          return;
        }
        const r = parseAsciicast(await res.text());
        if (gone || !hostRef.current) return;
        const term = new xterm.Terminal({
          cols: r.cols, rows: r.rows, disableStdin: true, cursorBlink: false, convertEol: false, scrollback: 5000,
          fontFamily: '"Geist Mono", ui-monospace, Menlo, Consolas, monospace',
          theme: { background: "#0d1117", foreground: "#d6dde6", cursor: "#d6dde6" },
        });
        term.open(hostRef.current);
        termRef.current = term;
        recRef.current = r;
        setRec(r);
        onFound?.(termMarks(r).map((m) => ({ atMs: m.atMs, kind: "mark" as const, text: m.text })));
        const start = Math.min(shell.startMs ?? 0, r.lengthMs);
        redraw(start);
      } catch {
        if (!gone) setError("Couldn't load this recording.");
      }
    })();
    return () => {
      gone = true;
      termRef.current?.dispose();
      termRef.current = null;
    };
    // Loaded once per recording; the start point is read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Fit the recorded columns into the stage by font size.
  useEffect(() => {
    const host = hostRef.current;
    if (!rec || !host) return;
    const fit = () => {
      const w = host.clientWidth - 16;
      const size = Math.max(7, Math.min(15, Math.floor((w / rec.cols) / 0.6)));
      if (termRef.current) termRef.current.options.fontSize = size;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [rec]);

  // Playback: write what falls due each tick.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const t = setInterval(() => {
      const term = termRef.current, r = recRef.current;
      if (!term || !r) return;
      const now = performance.now();
      let pos = posRef.current + (now - last) * speed;
      last = now;
      pos = Math.max(pos, skipIdle(r, cursor.current, posRef.current, IDLE_MS));
      const out: string[] = [];
      while (cursor.current < r.events.length && r.events[cursor.current].atMs <= pos) {
        const e = r.events[cursor.current++];
        if (e.code === "o") out.push(e.data);
        else if (e.code === "r") {
          const s = parseSize(e.data);
          if (s) {
            if (out.length) term.write(out.splice(0).join(""));
            term.resize(s[0], s[1]);
          }
        }
      }
      if (out.length) term.write(out.join(""));
      if (pos >= r.lengthMs) {
        pos = r.lengthMs;
        setPlaying(false);
      }
      posRef.current = pos;
      setPosition(pos);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [playing, speed]);

  const total = rec?.lengthMs ?? 0;
  const ready = !!rec;
  useEffect(() => { onState?.({ position, total, playing, ready, speed }); }, [onState, position, total, playing, ready, speed]);
  useEffect(() => {
    if (!control) return;
    control.current = { seek: (ms, play) => { redraw(Math.max(0, Math.min(ms, total))); if (play) setPlaying(true); } };
    return () => { control.current = null; };
  });

  function toggle() {
    if (!rec) return;
    if (!playing && posRef.current >= rec.lengthMs) redraw(0);
    setPlaying((p) => !p);
  }
  const seekTo = (ms: number) => redraw(Math.max(0, Math.min(ms, total)));

  if (error) return <p className="notice error">{error}</p>;

  return (
    <div ref={playerRef} className="rec-player" tabIndex={0} onKeyDown={(e) => playerKeys(e, toggle, (d) => seekTo(position + d), setSpeed)}>
      <div className="rec-stage term-stage" onClick={toggle}>
        {shell.overlay}
        <div ref={hostRef} className="term-host" aria-label="Terminal replay" />
        {!ready && <span className="term-loading">Loading the session from its connector…</span>}
      </div>
      <PlaybackBar
        ready={ready}
        playing={playing}
        position={position}
        total={total}
        onToggle={toggle}
        onSeek={seekTo}
        speed={speed}
        onSpeed={setSpeed}
        onFullscreen={() => toggleFullscreen(playerRef.current)}
        markers={shell.markers}
        wide={shell.wide}
        onWide={shell.onWide}
      />
    </div>
  );
}
