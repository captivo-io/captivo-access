"use client";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/brand";
import { Icon, type IconName } from "./icons";

export type PanelQuick = { key: string; icon: IconName; label: string; active?: boolean; disabled?: boolean; onClick?: () => void };
export type PanelItem = {
  key: string; icon: IconName; label: string; sub?: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "muted";
  onClick?: () => void; disabled?: boolean;
  chevron?: boolean; // navigates / opens something
};

function elapsed(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Branded slide-in control panel shared by the gateway (RDP/SSH/VNC) and the
// isolated-browser session. Header = Captivo Access mark + resource name + mode;
// a row of quick toggles; grouped list items with icon, label and live status;
// footer = session timer + leave.
export function SessionPanel({ siteName, mode, connectedAt, quick, sections, leave }: {
  siteName: string; mode: string; connectedAt: number | null;
  quick: PanelQuick[]; sections: { title: string; items: PanelItem[] }[];
  leave: { label: string; sub: string; onClick: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <>
      <button type="button" className={`ss-handle${open ? " open" : ""}`} onClick={() => setOpen((v) => !v)} aria-label="Session controls" aria-expanded={open} title="Session controls">
        <BrandMark size={18} />
        <span className="ss-handle-label">Controls</span>
      </button>
      {open && <div className="ss-scrim" onClick={() => setOpen(false)} />}
      <aside className={`ss-panel${open ? " open" : ""}`} role="dialog" aria-label="Session controls" aria-hidden={!open}>
        <header className="ss-head">
          <div className="ss-brand"><BrandMark size={26} /><span className="ss-brand-word">Captivo</span><span className="ss-brand-access">Access</span></div>
          <button type="button" className="ss-iconbtn" onClick={() => setOpen(false)} aria-label="Close">{Icon.close(16)}</button>
        </header>
        <div className="ss-site">
          <div className="ss-site-name">{siteName}</div>
          <div className="ss-site-mode">{mode}{connectedAt ? <> · <span className="ss-timer">{elapsed(connectedAt, now)}</span></> : null}</div>
        </div>
        {quick.length > 0 && (
          <div className="ss-quick">
            {quick.map((q) => (
              <button key={q.key} type="button" className={`ss-quick-btn${q.active ? " active" : ""}`} disabled={q.disabled} onClick={q.onClick} aria-pressed={q.active}>
                <span className="ss-quick-ic">{Icon[q.icon](20)}</span>
                <span>{q.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ss-body">
          {sections.map((s) => (
            <section key={s.title} className="ss-section">
              <div className="ss-section-title">{s.title}</div>
              {s.items.map((it) => (
                <button key={it.key} type="button" className={`ss-item tone-${it.tone ?? "default"}`} disabled={it.disabled || !it.onClick} onClick={it.onClick}>
                  <span className="ss-item-ic">{Icon[it.icon](18)}</span>
                  <span className="ss-item-main">
                    <span className="ss-item-label">{it.label}</span>
                    {it.sub ? <span className="ss-item-sub">{it.sub}</span> : null}
                  </span>
                  {it.chevron && it.onClick ? <span className="ss-item-chev">{Icon.chevron(16)}</span> : null}
                </button>
              ))}
            </section>
          ))}
        </div>
        <footer className="ss-foot">
          <button type="button" className="ss-item tone-danger" onClick={leave.onClick}>
            <span className="ss-item-ic">{Icon.leave(18)}</span>
            <span className="ss-item-main"><span className="ss-item-label">{leave.label}</span><span className="ss-item-sub">{leave.sub}</span></span>
          </button>
        </footer>
      </aside>
    </>
  );
}
