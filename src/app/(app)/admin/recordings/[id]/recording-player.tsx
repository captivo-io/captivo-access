"use client";
import { unreachableMessage } from "@/lib/recording/unreachable";
import { useEffect, useRef, useState } from "react";
import type { eventWithTime } from "rrweb";
import { hasFullSnapshot } from "@/lib/recording/snapshot";
import { PlaybackBar, playerKeys, toggleFullscreen, type PlayerShell } from "./playback-bar";

type Replayer = {
  wrapper: HTMLDivElement;
  iframe: HTMLIFrameElement;
  on(event: string, handler: (e?: unknown) => void): unknown;
  setConfig(c: { speed?: number }): void;
  getMetaData(): { totalTime: number };
  getCurrentTime(): number;
  play(offset?: number): void;
  pause(offset?: number): void;
  destroy(): void;
};

const TICK_MS = 250;

/**
 * Replays a web-app session (rrweb: the page's DOM and every change to it) with
 * the same controls as every other recording. The page is rebuilt in an iframe
 * at the size the user's browser had and scaled to fit. Idle stretches are
 * skipped, as rrweb's own player did.
 */
/** rrweb's page loads (Meta events) as navigations, timed from the recording's start. */
export function navigations(events: unknown[]): { atMs: number; kind: "nav"; text: string }[] {
  const first = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0;
  const out: { atMs: number; kind: "nav"; text: string }[] = [];
  for (const e of events as { type?: number; timestamp?: number; data?: { href?: string } }[]) {
    if (e?.type !== 4 || !e.data?.href || typeof e.timestamp !== "number") continue;
    let text = e.data.href;
    try { const u = new URL(e.data.href); text = u.pathname + u.search + u.hash; } catch { /* keep as recorded */ }
    if (out.at(-1)?.text !== text) out.push({ atMs: Math.max(0, e.timestamp - first), kind: "nav", text });
  }
  return out;
}

export function RecordingPlayer({ id, shell = {} }: { id: string; shell?: PlayerShell }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState(1);
  // Read once, when the recording loads.
  const startRef = useRef(shell.startMs);
  const onFoundRef = useRef(shell.onFound);

  useEffect(() => {
    let disposed = false;
    const fit = () => {
      const r = replayerRef.current;
      const stage = stageRef.current;
      if (!r || !stage) return;
      const iw = Number(r.iframe.width) || r.iframe.clientWidth;
      const ih = Number(r.iframe.height) || r.iframe.clientHeight;
      if (!iw || !ih) return;
      const full = !!document.fullscreenElement;
      const maxH = full ? window.innerHeight - 64 : window.innerHeight * 0.7;
      const s = Math.min(stage.clientWidth / iw, maxH / ih, full ? Infinity : 1);
      stage.style.height = `${Math.round(ih * s)}px`;
      r.wrapper.style.transform = `scale(${s})`;
      r.wrapper.style.left = `${Math.max(0, (stage.clientWidth - iw * s) / 2)}px`;
    };
    (async () => {
      try {
        const res = await fetch(`/api/admin/recordings/${id}/events`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          setError(unreachableMessage(res.status, typeof body?.error === "string" ? body.error : undefined, "Couldn't load this recording"));
          return;
        }
        const body = await res.json();
        const events: unknown[] = Array.isArray(body.events) ? body.events : [];
        if (events.length < 2) { setEmpty(true); return; }
        if (!hasFullSnapshot(events)) { setIncomplete(true); return; }
        if (disposed || !stageRef.current) return;
        const { Replayer } = await import("rrweb");
        // The cursor's look comes with rrweb-player's stylesheet.
        await import("rrweb-player/dist/style.css");
        stageRef.current.innerHTML = "";
        const r = new Replayer(events as unknown as eventWithTime[], {
          root: stageRef.current,
          skipInactive: true,
          mouseTail: false,
        }) as unknown as Replayer;
        replayerRef.current = r;
        r.on("resize", fit);
        r.on("finish", () => setPlaying(false));
        setTotal(r.getMetaData().totalTime);
        onFoundRef.current?.(navigations(events));
        const start = Math.min(startRef.current ?? 0, r.getMetaData().totalTime);
        r.pause(start); // draw the first frame (or the asked-for one)
        setPosition(start);
        fit();
        setReady(true);
      } catch {
        setError("Couldn't play this recording.");
      }
    })();
    window.addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", fit);
    return () => {
      disposed = true;
      window.removeEventListener("resize", fit);
      document.removeEventListener("fullscreenchange", fit);
      try { replayerRef.current?.destroy(); } catch { /* ignore */ }
      replayerRef.current = null;
    };
  }, [id]);

  // The replayer keeps its own time; the clock reads it while playing.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const r = replayerRef.current;
      if (r) setPosition(Math.min(r.getCurrentTime(), total));
    }, TICK_MS);
    return () => clearInterval(t);
  }, [playing, total]);

  function toggle() {
    const r = replayerRef.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPosition(Math.min(r.getCurrentTime(), total));
      setPlaying(false);
    } else {
      r.play(position >= total ? 0 : position);
      setPlaying(true);
    }
  }
  function seekTo(ms: number) {
    const r = replayerRef.current;
    if (!r) return;
    const at = Math.max(0, Math.min(ms, total));
    if (playing) r.play(at);
    else r.pause(at);
    setPosition(at);
  }
  function changeSpeed(s: number) {
    setSpeed(s);
    replayerRef.current?.setConfig({ speed: s });
  }

  const { onState, control } = shell;
  useEffect(() => { onState?.({ position, total, playing, ready, speed }); }, [onState, position, total, playing, ready, speed]);
  useEffect(() => {
    if (!control) return;
    control.current = {
      seek: (ms, play) => {
        const r = replayerRef.current;
        if (!r) return;
        const at = Math.max(0, Math.min(ms, total));
        if (play || playing) { r.play(at); setPlaying(true); } else r.pause(at);
        setPosition(at);
      },
    };
    return () => { control.current = null; };
  });

  if (error) return <p className="notice error">{error}</p>;
  if (empty) return <p className="notice">This recording is too short to play.</p>;
  if (incomplete)
    return <p className="notice">This recording is incomplete and can&apos;t be replayed (its opening snapshot was not captured).</p>;
  return (
    <>
      <div ref={playerRef} className="rec-player" tabIndex={0} onKeyDown={(e) => playerKeys(e, toggle, (d) => seekTo(position + d), changeSpeed)}>
        <div className="rec-stage-wrap">
          <div ref={stageRef} className="rec-stage web-recording" />
          {shell.overlay}
        </div>
        <PlaybackBar
          ready={ready}
          playing={playing}
          position={position}
          total={total}
          onToggle={toggle}
          onSeek={seekTo}
          speed={speed}
          onSpeed={changeSpeed}
          onFullscreen={() => toggleFullscreen(playerRef.current)}
          markers={shell.markers}
          wide={shell.wide}
          onWide={shell.onWide}
        />
      </div>
    </>
  );
}
