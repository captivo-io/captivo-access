"use client";

import { useEffect, useRef } from "react";

/** The side panel for one audit row: Esc, the scrim or × closes it. */
export function AuditDrawer({ title, badge, onClose, children }: { title: string; badge?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <>
      <div className="au-scrim" onClick={onClose} />
      <aside ref={ref} className="au-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="au-drawer-head">
          <div className="au-drawer-t">{badge}<b>{title}</b></div>
          <button type="button" className="rs-clear" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="au-drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function DetailList({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="au-dl">
      {items.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}
