"use client";
import { useEffect, useRef, useState } from "react";
import { KeystrokeTimeline } from "./keystroke-timeline";
import { PlaybackBar, playerKeys, toggleFullscreen } from "./playback-bar";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plays a guac recording WHILE it downloads. Since 2.21 this is the player for
 * terminal sessions (SSH, telnet: small, they load in a second) and for an
 * RDP/VNC session until its connector has turned it into video, which then
 * plays in VideoRecordingPlayer instead.
 * A guac recording is a drawing
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
 *
 * Buffering keeps a lead: when playback reaches the end of what is loaded it
 * waits until LEAD_MS more is in (or all of it) before going on. Resuming on
 * every new frame made the library draw each one the moment it arrived, so a
 * heavy stretch (the full-screen start of an RDP session) played at download
 * speed: the picture lagged, then raced. A seek past what is loaded is kept as
 * a target and taken once the download gets there; clamping it to the loaded
 * end looked like the bar refusing the move.
 */
const TICK_MS = 250;
const LEAD_MS = 5_000;

export function GuacRecordingPlayer({ recordingId, estimatedMs = 0, onInteract }: { recordingId: string; estimatedMs?: number; onInteract?: () => void }) {
  const playerRef = useRef<HTMLDivElement>(null);
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
  // A seek to a point not yet loaded, taken when the download reaches it.
  const pendingSeek = useRef<number | null>(null);
  // Fits the display to its box again (window resized, full screen toggled).
  const refit = useRef<() => void>(() => {});
  useEffect(() => {
    const again = () => refit.current();
    window.addEventListener("resize", again);
    document.addEventListener("fullscreenchange", again);
    return () => {
      window.removeEventListener("resize", again);
      document.removeEventListener("fullscreenchange", again);
    };
  }, []);
  const setAnchor = (pos: number) => { anchor.current = { pos, at: performance.now() }; setPosition(pos); };

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const a = anchor.current;
      setPosition(Math.min(a.pos + (performance.now() - a.at), durationRef.current));
    }, TICK_MS);
    return () => clearInterval(t);
  }, [playing]);

  // Go on (or start) when there is enough to play: a pending seek first, then
  // playback once LEAD_MS past the current point is in, or the whole file.
  const tryResume = () => {
    const r = recRef.current;
    if (!r || seeking.current) return;
    const target = pendingSeek.current;
    if (target !== null) {
      if (!loadedRef.current && durationRef.current < target) return;
      pendingSeek.current = null;
      const ms = Math.min(target, durationRef.current);
      seeking.current = true;
      r.seek(ms, () => { seeking.current = false; setAnchor(ms); tryResume(); });
      return;
    }
    if (!wantPlay.current || r.isPlaying()) return;
    if (loadedRef.current || durationRef.current >= r.getPosition() + LEAD_MS) r.play();
    else setBuffering(true);
  };
  // The library's callbacks are set up once; they reach the current tryResume.
  const tryResumeRef = useRef(tryResume);
  useEffect(() => { tryResumeRef.current = tryResume; });

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
        // Scaled down to the page's width; in full screen, up or down to fit it.
        const fit = () => {
          const dw = display.getWidth();
          const dh = display.getHeight();
          if (dw <= 0 || dh <= 0) return;
          const full = !!document.fullscreenElement;
          const byWidth = (displayRef.current?.clientWidth ?? dw) / dw;
          display.scale(full ? Math.min(byWidth, (window.innerHeight - 64) / dh) : Math.min(byWidth, 1));
        };
        display.onresize = fit;
        refit.current = fit;

        recording.onload = () => {
          loadedRef.current = true;
          setLoaded(true);
          setReady(true);
          durationRef.current = recording.getDuration();
          setDuration(durationRef.current);
          fit();
          tryResumeRef.current();
        };
        recording.onprogress = (dur: number) => {
          durationRef.current = dur;
          setDuration(dur);
          if (dur > 0) setReady(true);
          // Waiting for the download (to play on, or for a seek target).
          if (wantPlay.current || pendingSeek.current !== null) tryResumeRef.current();
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
    onInteract?.();
    if (playing || buffering) {
      wantPlay.current = false;
      setBuffering(false);
      r.pause();
    } else {
      wantPlay.current = true;
      tryResume();
    }
  }
  function seekTo(ms: number) {
    const r = recRef.current;
    if (!r) return;
    onInteract?.();
    const millis = Math.max(0, loadedRef.current ? Math.min(ms, durationRef.current) : ms);
    // Hold playback through the seek; tryResume decides when it goes on, so a
    // target near the loaded end waits for its lead instead of racing.
    seeking.current = true;
    if (r.isPlaying()) r.pause();
    setPosition(millis);
    anchor.current = { pos: millis, at: performance.now() };
    if (!loadedRef.current && millis > durationRef.current) {
      // Not loaded yet: keep the target, take it when the download gets there.
      seeking.current = false;
      pendingSeek.current = millis;
      if (wantPlay.current) setBuffering(true);
      return;
    }
    pendingSeek.current = null;
    r.seek(millis, () => { seeking.current = false; setAnchor(millis); tryResume(); });
  }
  const jumpTo = seekTo;

  // While loading, the bar spans the expected length; once loaded, the real one.
  const total = loaded ? duration : Math.max(duration, estimatedMs);
  const loadedPct = total > 0 ? Math.min(100, (duration / total) * 100) : 0;

  if (error) return <p className="notice error">{error}</p>;

  return (
    <div className="guac-recording">
      <div ref={playerRef} className="rec-player" tabIndex={0} onKeyDown={(e) => playerKeys(e, toggle, (d) => seekTo(position + d))}>
        <div ref={displayRef} className="guac-recording-display rec-stage" />
        <PlaybackBar
          ready={ready}
          playing={playing}
          buffering={buffering}
          position={position}
          total={total}
          loadedPct={loadedPct}
          note={ready && !loaded ? "loading" : undefined}
          onToggle={toggle}
          onSeek={seekTo}
          onFullscreen={() => toggleFullscreen(playerRef.current)}
        />
      </div>
      <KeystrokeTimeline recordingId={recordingId} onJump={jumpTo} disabled={!ready} />
    </div>
  );
}
