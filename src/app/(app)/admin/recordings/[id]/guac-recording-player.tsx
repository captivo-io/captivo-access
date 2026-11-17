"use client";
import { useEffect, useRef, useState } from "react";
import { KeystrokeTimeline, fmtMs as fmt } from "./keystroke-timeline";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plays a guac recording WHILE it downloads. A guac recording is a drawing
 * instruction stream, not a video, and the library only replays what it has
 * parsed; the player used to wait for the whole file (353 MB for a 25-minute RDP
 * session) before offering Play. Now Play works as soon as the first frames are
 * in; when playback catches up with the download the library pauses, and this
 * resumes it as more arrives ("Buffering…"). Seeking reaches only what is loaded
 * so far, which the bar shows shaded.
 *
 * The clock runs on its own while playing. The library reports a position only
 * when it draws a frame, and an idle screen draws none: the clock used to stop
 * through a still stretch (9:10 for half a minute) and then jump (to 9:40),
 * though playback itself waited the right time. The bar is laid out on the
 * recording's expected length (estimatedMs, from its metadata) while it loads,
 * not on the loaded length, which grew faster than playback and made the thumb
 * slide back.
 */
const TICK_MS = 250;

export function GuacRecordingPlayer({ recordingId, estimatedMs = 0 }: { recordingId: string; estimatedMs?: number }) {
  const displayRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // first frames are in: playable
  const [loaded, setLoaded] = useState(false); // the whole file is in
  const [buffering, setBuffering] = useState(false);
  // The user asked to play (and has not paused): the library's own pauses at the
  // end of what is loaded are waits, not stops.
  const wantPlay = useRef(false);
  const loadedRef = useRef(false);
  // A seek pauses and resumes playback by itself; those are neither the user
  // pausing nor the download running out.
  const seeking = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0); // what is loaded so far (all of it once loaded)
  // Where the clock was last set from the recording, and when: it runs on from there.
  const anchor = useRef({ pos: 0, at: 0 });
  const durationRef = useRef(0);
  const setAnchor = (pos: number) => { anchor.current = { pos, at: performance.now() }; setPosition(pos); };

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const a = anchor.current;
      setPosition(Math.min(a.pos + (performance.now() - a.at), durationRef.current));
    }, TICK_MS);
    return () => clearInterval(t);
  }, [playing]);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const mod: any = await import("guacamole-common-js");
        const Guacamole: any = mod.default ?? mod;
        if (disposed || !displayRef.current) return;

        // Feed the recording from a StaticHTTPTunnel, not a Blob: passing a Blob
        // directly to SessionRecording is broken in guacamole-common-js 1.5.0
        // (its internal recordingBlob is never assigned in the Blob branch, so
        // construction throws "reading 'size'"). The tunnel path is the canonical
        // recording-replay mechanism and works.
        const tunnel = new Guacamole.StaticHTTPTunnel(`/api/admin/recordings/${recordingId}/guac`);
        const recording = new Guacamole.SessionRecording(tunnel);
        recRef.current = recording;

        const display = recording.getDisplay();
        displayRef.current.innerHTML = "";
        displayRef.current.appendChild(display.getElement());
        const fit = () => {
          const dw = display.getWidth();
          const dh = display.getHeight();
          if (dw > 0 && dh > 0) display.scale(Math.min((displayRef.current?.clientWidth ?? dw) / dw, 1));
        };
        display.onresize = fit;

        recording.onload = () => {
          loadedRef.current = true;
          setLoaded(true);
          setReady(true);
          durationRef.current = recording.getDuration();
          setDuration(durationRef.current);
          fit();
          if (wantPlay.current && !seeking.current && !recording.isPlaying()) recording.play();
        };
        recording.onprogress = (dur: number) => {
          durationRef.current = dur;
          setDuration(dur);
          if (dur > 0) setReady(true);
          // Caught up with the download while playing: go on with what arrived.
          if (wantPlay.current && !seeking.current && !recording.isPlaying()) recording.play();
        };
        // A frame drawn while playing. During a seek the library replays from the
        // nearest keyframe up to the target: those steps are not shown.
        recording.onseek = (millis: number) => { if (!seeking.current) setAnchor(millis); };
        recording.onplay = () => {
          wantPlay.current = true;
          setPlaying(true);
          setBuffering(false);
          setAnchor(recording.getPosition());
        };
        recording.onpause = () => {
          setPlaying(false);
          // The library resumes from its last frame, so the clock goes back to it.
          if (!seeking.current) setAnchor(recording.getPosition());
          if (seeking.current || !wantPlay.current) return;
          if (loadedRef.current) wantPlay.current = false; // the real end
          else setBuffering(true); // caught up with the download
        };
        recording.onerror = (status: unknown) => {
          console.error("[guac-recording] onerror:", status);
          setError(`Couldn't play this recording. (${typeof status === "string" ? status : JSON.stringify(status)})`);
        };

        tunnel.connect("");
      } catch (err) {
        console.error("[guac-recording] failed:", err);
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        setError(`Couldn't play this recording. (${msg})`);
      }
    })();
    return () => {
      disposed = true;
      try { recRef.current?.pause?.(); } catch { /* ignore */ }
      recRef.current = null;
    };
  }, [recordingId]);

  function toggle() {
    const r = recRef.current;
    if (!r) return;
    if (playing || buffering) {
      wantPlay.current = false;
      setBuffering(false);
      r.pause();
    } else {
      wantPlay.current = true;
      r.play();
    }
  }
  function seekTo(ms: number) {
    const r = recRef.current;
    if (!r) return;
    // Only what is loaded can be reached; past it, the end of the loaded part.
    const millis = Math.min(Math.max(0, ms), durationRef.current);
    seeking.current = true;
    setPosition(millis);
    r.seek(millis, () => { seeking.current = false; setAnchor(millis); });
  }
  function onScrub(e: React.ChangeEvent<HTMLInputElement>) {
    seekTo(Number(e.target.value));
  }
  const jumpTo = seekTo;

  // While loading, the bar spans the expected length; once loaded, the real one.
  const total = loaded ? duration : Math.max(duration, estimatedMs);
  const loadedPct = total > 0 ? Math.min(100, (duration / total) * 100) : 0;
  const playedPct = total > 0 ? Math.min(100, (position / total) * 100) : 0;


  if (error) return <p className="notice error">{error}</p>;

  return (
    <div className="guac-recording">
      <div ref={displayRef} className="guac-recording-display" />
      <div className="guac-recording-controls">
        <button type="button" className="btn sm" onClick={toggle} disabled={!ready}>
          {!ready ? "Loading…" : buffering ? "Buffering…" : playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          className="guac-seek"
          min={0}
          max={total || 0}
          value={Math.min(position, total)}
          onChange={onScrub}
          aria-label="Seek"
          disabled={!ready}
          style={{ ["--played" as string]: `${playedPct}%`, ["--loaded" as string]: `${loadedPct}%` }}
        />
        <span className="cell-sub">{fmt(position)} / {fmt(total)}{ready && !loaded ? " · loading" : ""}</span>
      </div>
      <KeystrokeTimeline recordingId={recordingId} onJump={jumpTo} disabled={!ready} />
    </div>
  );
}
