"use client";
import { useEffect, useRef, useState } from "react";
import { KeystrokeTimeline, fmtMs as fmt } from "./keystroke-timeline";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function GuacRecordingPlayer({ recordingId }: { recordingId: string }) {
  const displayRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

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

        recording.onload = () => { setReady(true); setDuration(recording.getDuration()); fit(); };
        recording.onprogress = (dur: number) => setDuration(dur);
        recording.onseek = (millis: number) => setPosition(millis);
        recording.onplay = () => setPlaying(true);
        recording.onpause = () => setPlaying(false);
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
    if (playing) r.pause();
    else r.play();
  }
  function onScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const r = recRef.current;
    if (!r) return;
    const millis = Number(e.target.value);
    r.seek(millis, () => setPosition(millis));
  }
  function jumpTo(atMs: number) {
    const r = recRef.current;
    if (!r) return;
    r.seek(atMs, () => setPosition(atMs));
  }


  if (error) return <p className="notice error">{error}</p>;

  return (
    <div className="guac-recording">
      <div ref={displayRef} className="guac-recording-display" />
      <div className="guac-recording-controls">
        <button type="button" className="btn sm" onClick={toggle} disabled={!ready}>
          {!ready ? "Loading…" : playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          value={position}
          onChange={onScrub}
          aria-label="Seek"
          disabled={!ready}
          style={{ flex: 1 }}
        />
        <span className="cell-sub">{fmt(position)} / {fmt(duration)}</span>
      </div>
      <KeystrokeTimeline recordingId={recordingId} onJump={jumpTo} disabled={!ready} />
    </div>
  );
}
