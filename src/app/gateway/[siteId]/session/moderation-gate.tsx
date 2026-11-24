"use client";
import { useEffect, useState } from "react";
import { useModerationRequest } from "@/lib/moderation/use-request";

const left = (until: string | null, now: number) => {
  if (!until) return "";
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * A resource that needs a moderator: the session (children) starts only once
 * a moderator admits it. Until then the user waits here, on the same dark
 * screen the connection splash uses.
 */
export function ModerationGate({ siteId, siteName, children }: { siteId: string; siteName: string; children: React.ReactNode }) {
  const req = useModerationRequest(siteId, "browser");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (req.status === "admitted" || req.status === "started") return <>{children}</>;

  const waiting = req.status === "waiting" || req.status === "asking";
  const title = {
    asking: "Asking for a moderator…",
    waiting: "Waiting for a moderator",
    declined: "A moderator declined this session",
    expired: "No moderator joined in time",
    cancelled: "You stopped waiting",
    error: "The request couldn't be sent",
    no_moderators: "Nobody can moderate this resource",
  }[req.status];
  const note = waiting
    ? "This resource needs a moderator. The moderators have been told; the session starts as soon as one joins."
    : req.status === "declined"
      ? "You can ask again, or contact your Captivo admin."
      : req.status === "expired"
        ? "Requests wait 10 minutes. Ask again when a moderator is available."
        : req.status === "no_moderators"
          ? "This resource needs a moderator, and nobody else in your organization may moderate sessions. Contact your Captivo admin."
          : req.status === "error"
            ? "Check your connection and try again."
            : "Ask again when you are ready.";
  return (
    <div className="connect-splash mod-gate" role="status" aria-live="polite">
      {waiting && <div className="connect-splash-ring" aria-hidden="true" />}
      <div className="connect-splash-body">
        <span className="mod-gate-eyebrow">Four-eyes session</span>
        <div className="connect-splash-site">{siteName}</div>
        <div className="mod-gate-title">{title}</div>
        <p className="connect-splash-note mod-gate-note">{note}</p>
        {req.status === "waiting" && req.expiresAt && <div className="mod-gate-timer">The request ends in <b>{left(req.expiresAt, now)}</b></div>}
        <div className="mod-gate-actions">
          {waiting
            ? <button type="button" className="mod-gate-btn ghost" onClick={req.cancel}>Stop waiting</button>
            : <button type="button" className="mod-gate-btn" onClick={req.retry}>Ask again</button>}
          <a className="mod-gate-btn ghost" href="/access">Back to My access</a>
        </div>
        <p className="mod-gate-fine">The moderator watches the whole session. Your keyboard and mouse work only while they are watching.</p>
      </div>
    </div>
  );
}
