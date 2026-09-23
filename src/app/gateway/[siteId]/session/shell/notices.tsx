"use client";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/brand";
import { Icon } from "./icons";

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
export function MonitorNotice({ watching, controlHeld }: { watching: boolean; controlHeld: boolean }) {
  if (!watching && !controlHeld) return null;
  return (
    <div className={`ss-monitor${controlHeld ? " control" : ""}`} role="status">
      {Icon.eye(16)}
      <span>{controlHeld ? "An administrator has taken control of this session." : "This session is being monitored live."}</span>
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
