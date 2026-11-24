"use client";

import { useEffect, useEffectEvent, useRef } from "react";

/** The side panel for one audit record: Esc, the backdrop or × closes it. */
export function AuditDrawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // Focus is taken once, on opening: the parent passes a new onClose each
  // render (every second in Live sessions), which must not pull focus back.
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return (
    <>
      <div className="au-scrim" onClick={onClose} />
      <aside ref={ref} className="au-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="au-drawer-head">
          <span className="kcell-k">{title}</span>
          <button type="button" className="rs-clear" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="au-drawer-body">{children}</div>
        {footer && <footer className="au-drawer-foot">{footer}</footer>}
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
