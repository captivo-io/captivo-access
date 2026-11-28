"use client";
import { useEffect, useRef, useState } from "react";
import { explainFailure } from "@/lib/recording/unreachable";
import { PlaybackBar, playerKeys, toggleFullscreen, type PlayerShell } from "./playback-bar";

/**
 * Plays a recording stored as WebM: an isolated-browser session, and an RDP/VNC
 * session once its connector has turned it into video. The browser streams it
 * with Range requests straight from the serving route, so it starts at once and
 * seeks anywhere without downloading what lies before.
 *
 * durationMs is the length the connector measured, if it has; it stands in when
 * the file states none (an isolated-browser video cut off before its session
 * closed, until the connector repairs it).
 */
export function VideoRecordingPlayer({ id, durationMs = 0, shell = {} }: { id: string; durationMs?: number; shell?: PlayerShell }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(durationMs);
  const [buffered, setBuffered] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let gone = false;
    const length = () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : durationMs;
      setDuration(d);
    };
    const bufferedEnd = () => {
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
      }
      setBuffered(end * 1000);
    };
    const on: Array<[string, () => void]> = [
      ["loadedmetadata", () => {
        length();
        setReady(true);
        if (shell.startMs) { v.currentTime = shell.startMs / 1000; setPosition(shell.startMs); }
      }],
      ["durationchange", length],
      ["timeupdate", () => { setPosition(v.currentTime * 1000); bufferedEnd(); }],
      ["progress", bufferedEnd],
      ["play", () => setPlaying(true)],
      ["pause", () => { setPlaying(false); setBuffering(false); }],
      ["ended", () => { setPlaying(false); setBuffering(false); }],
      ["waiting", () => setBuffering(true)],
      ["playing", () => setBuffering(false)],
      ["seeked", () => { setPosition(v.currentTime * 1000); bufferedEnd(); }],
      // The element only says that it failed. The server knows whether the connector holding the video is offline,
      // so it is asked (one byte, no more); a video that is reachable but will not decode keeps its own message.
      ["error", () => {
        void explainFailure(`/api/admin/recordings/${id}/video`, "Couldn't play this recording's video. The file may be damaged or its format unsupported by this browser.", fetch, { Range: "bytes=0-0" })
          .then((m) => { if (!gone) setError(m); });
      }],
    ];
    for (const [e, f] of on) v.addEventListener(e, f);
    // The element is in the server's HTML and may have its metadata before
    // these listeners exist (a fast or cached answer): take it now, or the
    // player would wait for an event that already fired.
    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) on[0][1]();
    return () => { gone = true; for (const [e, f] of on) v.removeEventListener(e, f); };
    // The start point is read once, when the video first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs]);

  const { onState, control } = shell;
  useEffect(() => { onState?.({ position, total: duration, playing, ready, speed }); }, [onState, position, duration, playing, ready, speed]);
  useEffect(() => {
    if (!control) return;
    control.current = { seek: (ms, play) => { seekTo(ms); if (play) void videoRef.current?.play().catch(() => {}); } };
    return () => { control.current = null; };
  });

  function toggle() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  }
  function seekTo(ms: number) {
    const v = videoRef.current;
    if (!v) return;
    const max = duration > 0 ? duration : ms;
    v.currentTime = Math.max(0, Math.min(ms, max)) / 1000;
    setPosition(v.currentTime * 1000);
  }
  function changeSpeed(s: number) {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }

  if (error) return <p className="notice error">{error}</p>;

  return (
    <>
      <div ref={playerRef} className="rec-player" tabIndex={0} onKeyDown={(e) => playerKeys(e, toggle, (d) => seekTo(position + d), changeSpeed)}>
        <div className="rec-stage">
          {shell.overlay}
          <video
            ref={videoRef}
            src={`/api/admin/recordings/${id}/video`}
            preload="metadata"
            playsInline
            onClick={toggle}
          />
        </div>
        <PlaybackBar
          ready={ready}
          playing={playing}
          buffering={buffering}
          position={position}
          total={duration}
          loadedPct={duration > 0 ? (buffered / duration) * 100 : 0}
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
