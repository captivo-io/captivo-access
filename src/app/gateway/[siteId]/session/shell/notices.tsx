"use client";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/brand";
import { Icon } from "./icons";
import type { SessionFailure } from "@/lib/gateway/connect-error";

// Recording notice, one look in every session mode: a branded card for the
// first seconds (like the PAM products vendors already know), then it folds
// into a small persistent "REC" pill so the fact stays visible without
// covering the app. Never interactive.
export function RecordingNotice({ active, expandedMs = 6000 }: { active: boolean; expandedMs?: number }) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setExpanded(false), expandedMs);
    return () => clearTimeout(t);
  }, [active, expandedMs]);
  if (!active) return null;
  return (
    <div className={`ss-rec${expanded ? " expanded" : ""}`} role="status" aria-live="polite">
      <span className="ss-rec-dot" />
      {expanded ? (
        <>
          <BrandMark size={22} />
          <span className="ss-rec-text"><b>This session is being recorded</b><span>Captivo Access · security &amp; compliance</span></span>
        </>
      ) : (
        <span className="ss-rec-pill">REC</span>
      )}
    </div>
  );
}

// Live-monitoring / control notice (an admin watching or driving the session).
// Invited guests are named: an admin let someone from outside in, and the
// user is told who.
export function MonitorNotice({ watching, controlHeld, guests, controlBy }: { watching: boolean; controlHeld: boolean; guests?: string[] | null; controlBy?: string }) {
  if (!watching && !controlHeld) return null;
  const named = (guests ?? []).map((g) => `${g} (guest)`);
  const text = controlHeld
    ? controlBy && controlBy !== "An admin"
      ? `${controlBy} has taken control of this session.`
      : "An administrator has taken control of this session."
    : named.length > 0
      ? `This session is being watched live by ${named.join(", ")}.`
      : "This session is being monitored live.";
  return (
    <div className={`ss-monitor${controlHeld ? " control" : ""}`} role="status">
      {Icon.eye(16)}
      <span>{text}</span>
    </div>
  );
}

export interface SessionModeration { present: boolean; deadline?: string }

/**
 * A moderated session without its moderator watching: the user's input is
 * paused (the data plane drops it) and the session ends at the deadline
 * unless a moderator joins. Counts down every second.
 */
export function ModerationNotice({ moderation }: { moderation: SessionModeration | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  const paused = !!moderation && !moderation.present;
  useEffect(() => {
    if (!paused) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [paused]);
  if (!paused) return null;
  const s = moderation.deadline ? Math.max(0, Math.round((Date.parse(moderation.deadline) - now) / 1000)) : null;
  return (
    <div className="ss-moderation" role="alert">
      {Icon.block(16)}
      <span>
        <b>Waiting for the moderator.</b> Your keyboard and mouse are paused until they are watching.
        {s !== null && <> Without a moderator the session ends in <span className="ss-mod-clock">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>.</>}
      </span>
    </div>
  );
}

export interface AdminMessage { id: string; text: string; at: string }

const MESSAGE_SHOWN_MS = 12_000;

/**
 * An administrator's message, sent from the console's Sessions page while the
 * session runs. The watch-status poll carries the latest one for a while; each
 * is shown once, at the top, until read (or 12 s pass).
 */
export function AdminMessageBanner({ message }: { message: AdminMessage | null | undefined }) {
  const [seen, setSeen] = useState<string | null>(null);
  const [shown, setShown] = useState<AdminMessage | null>(null);
  useEffect(() => {
    if (!message || message.id === seen) return;
    setSeen(message.id);
    setShown(message);
  }, [message, seen]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), MESSAGE_SHOWN_MS);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="ss-admin-msg" role="alert">
      <span className="ss-admin-tag">ADMIN</span>
      <span className="ss-admin-text">{shown.text}</span>
      <button type="button" aria-label="Dismiss" onClick={() => setShown(null)}>×</button>
    </div>
  );
}

export type ToastTone = "info" | "ok" | "warn" | "danger";
export interface ToastState { text: string; tone?: ToastTone; icon?: ReactNode }

// Bottom-center toast; the parent owns the timeout.
export function SessionToast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div className={`ss-toast tone-${toast.tone ?? "info"}`} role="status">
      {toast.icon ?? (toast.tone === "danger" || toast.tone === "warn" ? Icon.block(16) : Icon.info(16))}
      <span>{toast.text}</span>
    </div>
  );
}

// Full-screen drag target. "over" = files hovering and upload allowed;
// "blocked" = files hovering but the resource has no file channel.
export function DropOverlay({ state, siteName }: { state: "idle" | "over" | "blocked"; siteName: string }) {
  if (state === "idle") return null;
  return (
    <div className={`ss-drop${state === "blocked" ? " blocked" : ""}`} aria-hidden="true">
      <div className="ss-drop-box">
        {state === "blocked" ? Icon.block(34) : Icon.drop(34)}
        <div className="ss-drop-title">{state === "blocked" ? "File transfer is disabled for this resource" : `Drop to upload to ${siteName}`}</div>
        <div className="ss-drop-sub">{state === "blocked" ? "Your administrator has not enabled file transfer here." : "Files are sent straight into the session."}</div>
      </div>
    </div>
  );
}

// One-time onboarding tips shown for a few seconds after connect (per site, per
// browser session), instead of a hint that sits on screen forever.
export function FirstTips({ siteId, tips, ms = 9000 }: { siteId: string; tips: string[]; ms?: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (tips.length === 0) return;
    const k = `ca_tips_${siteId}`;
    try {
      if (sessionStorage.getItem(k)) return;
      sessionStorage.setItem(k, "1");
    } catch { /* still show once */ }
    setShow(true);
    const t = setTimeout(() => setShow(false), ms);
    return () => clearTimeout(t);
  }, [siteId, tips.length, ms]);
  if (!show) return null;
  return (
    <div className="ss-tips" role="status">
      <BrandMark size={18} />
      <div className="ss-tips-list">{tips.map((t) => <span key={t}>{t}</span>)}</div>
      <button type="button" className="ss-iconbtn" onClick={() => setShow(false)} aria-label="Dismiss">{Icon.close(14)}</button>
    </div>
  );
}

// Shown when the periodic access recheck closed the session: why, and the way out.
export function SessionEnded({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="ss-drop blocked ss-ended" role="alertdialog" aria-label="Session ended">
      <div className="ss-drop-box">
        {Icon.block(34)}
        <div className="ss-drop-title">Your session was ended</div>
        <div className="ss-drop-sub">{message}</div>
        <a className="ss-ended-back" href="/access">Back to My access</a>
      </div>
    </div>
  );
}

// Shown when guacd or the tunnel stopped the session: what went wrong, in words
// a vendor can pass on, with guacd's own text underneath.
export function SessionFailed({ failure }: { failure: SessionFailure | null }) {
  if (!failure) return null;
  return (
    <div className="ss-drop blocked ss-ended" role="alertdialog" aria-label={failure.title}>
      <div className="ss-drop-box">
        {Icon.block(34)}
        <div className="ss-drop-title">{failure.title}</div>
        <div className="ss-drop-sub">{failure.hint}</div>
        {failure.detail && <div className="ss-failed-detail">Details: {failure.detail}</div>}
        <div className="ss-failed-acts">
          <button type="button" className="ss-ended-back" onClick={() => window.location.reload()}>Try again</button>
          <a className="ss-ended-back" href="/access">Back to My access</a>
        </div>
      </div>
    </div>
  );
}
