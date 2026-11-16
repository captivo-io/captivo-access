"use client";
import { useEffect, useRef, useState } from "react";
import type { eventWithTime } from "rrweb";
import { hasFullSnapshot } from "@/lib/recording/snapshot";
import { KeystrokeTimeline } from "./keystroke-timeline";

export function RecordingPlayer({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const playerRef = useRef<{ $destroy?: () => void; goto?: (ms: number, play?: boolean) => void } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [incomplete, setIncomplete] = useState(false);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/recordings/${id}/events`);
        if (!res.ok) { setError("Couldn't load this recording."); return; }
        const body = await res.json();
        const events: unknown[] = Array.isArray(body.events) ? body.events : [];
        if (events.length < 2) { setEmpty(true); return; }
        if (!hasFullSnapshot(events)) { setIncomplete(true); return; }
        if (disposed || !ref.current) return;
        const { default: Player } = await import("rrweb-player");
        await import("rrweb-player/dist/style.css");
        ref.current.innerHTML = "";
        const width = Math.max(320, Math.min(ref.current.clientWidth || 960, 1400));
        const p = new Player({
          target: ref.current,
          props: { events: events as unknown as eventWithTime[], autoPlay: true, showController: true, width, height: Math.round(width * 0.6) },
        });
        playerRef.current = p as unknown as { $destroy?: () => void; goto?: (ms: number, play?: boolean) => void };
        setReady(true);
      } catch {
        setError("Couldn't play this recording.");
      }
    })();
    return () => {
      disposed = true;
      playerRef.current?.$destroy?.();
      playerRef.current = null;
    };
  }, [id]);

  if (error) return <p className="notice error">{error}</p>;
  if (empty) return <p className="notice">This recording is too short to play.</p>;
  if (incomplete)
    return <p className="notice">This recording is incomplete and can&apos;t be replayed (its opening snapshot was not captured).</p>;
  return (
    <>
      <div ref={ref} className="web-recording" />
      <KeystrokeTimeline recordingId={id} onJump={(ms) => playerRef.current?.goto?.(ms, true)} disabled={!ready} />
    </>
  );
}
