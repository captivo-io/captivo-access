"use client";
import { useRef } from "react";
import { KeystrokeTimeline } from "./keystroke-timeline";

// Streams the assembled WebM straight from the serving route — no client-side blob
// assembly needed; the browser plays the video/webm response directly.
export function VideoRecordingPlayer({ id }: { id: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <>
      <video
        ref={ref}
        controls
        src={`/api/admin/recordings/${id}/video`}
        style={{ width: "100%", maxHeight: "70vh", background: "#000" }}
      />
      <KeystrokeTimeline
        recordingId={id}
        onJump={(ms) => {
          const v = ref.current;
          if (!v) return;
          v.currentTime = ms / 1000;
          void v.play().catch(() => {});
        }}
      />
    </>
  );
}
