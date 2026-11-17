"use client";
import { useEffect, useRef, useState } from "react";
import { GuacRecordingPlayer } from "./guac-recording-player";
import { VideoRecordingPlayer } from "./video-recording-player";

const POLL_MS = 4000;
const GIVE_UP_MS = 30 * 60_000;

/**
 * An RDP/VNC recording whose video its connector is still making (it starts as
 * soon as the session ends; a short session takes seconds, a 12-minute one
 * about two minutes). Meanwhile the recording plays from its instruction
 * stream. When the video is in, the page switches to it by itself, unless the
 * reviewer has started watching: then it offers the switch rather than pull the
 * recording out from under them.
 */
export function PreparingRecording({ id, estimatedMs }: { id: string; estimatedMs: number }) {
  const [ready, setReady] = useState<{ durationMs: number } | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [settled, setSettled] = useState(false); // worked on, kept as it is
  const touched = useRef(false);

  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const poll = async () => {
      if (stop) return;
      try {
        const r = await fetch(`/api/admin/recordings/${id}`, { cache: "no-store" });
        if (r.ok) {
          const s = (await r.json()) as { videoReady: boolean; reported: boolean; durationMs: number | null };
          if (s.videoReady) {
            setReady({ durationMs: s.durationMs ?? estimatedMs });
            if (!touched.current) setShowVideo(true);
            return;
          }
          if (s.reported) {
            setSettled(true);
            return;
          }
        }
      } catch {
        /* try again */
      }
      if (!stop && Date.now() - started < GIVE_UP_MS) timer = setTimeout(poll, POLL_MS);
    };
    let timer = setTimeout(poll, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, estimatedMs]);

  if (showVideo && ready) return <VideoRecordingPlayer id={id} durationMs={ready.durationMs} />;
  return (
    <>
      {settled ? null : ready ? (
        <div className="notice rec-preparing" role="status">
          The video of this recording is ready: it seeks anywhere at once.{" "}
          <button type="button" className="btn sm" onClick={() => setShowVideo(true)}>Switch to the video</button>
        </div>
      ) : (
        <div className="notice rec-preparing" role="status">
          Preparing the video of this recording (it is made once the session has ended). It switches over by itself; meanwhile it plays from here.
        </div>
      )}
      <GuacRecordingPlayer recordingId={id} estimatedMs={estimatedMs} onInteract={() => { touched.current = true; }} />
    </>
  );
}
