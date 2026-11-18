"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";

// A handle docked to a screen edge that the vendor can slide along it, so it
// never sits for good over the part of the remote screen they need. A press
// that moves more than a few pixels is a drag and does not click; the place is
// remembered per browser (localStorage, a convenience only).
const DRAG_PX = 4;
const MARGIN = 8;

function clampTop(top: number, height: number): number {
  return Math.min(Math.max(MARGIN, top), Math.max(MARGIN, window.innerHeight - height - MARGIN));
}

export function useEdgeDrag(storageKey: string) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [top, setTop] = useState<number | null>(null); // null: the stylesheet's place
  const drag = useRef<{ id: number; startY: number; startTop: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    let saved: number | null = null;
    try {
      const v = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(v) && v > 0) saved = v;
    } catch { /* storage unavailable */ }
    if (saved !== null) setTop(clampTop(saved, ref.current?.offsetHeight ?? 40));
  }, [storageKey]);

  // Keep it on screen when the window shrinks.
  useEffect(() => {
    if (top === null) return;
    const onResize = () => setTop((t) => (t === null ? t : clampTop(t, ref.current?.offsetHeight ?? 40)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [top]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !ref.current) return;
    drag.current = { id: e.pointerId, startY: e.clientY, startTop: ref.current.getBoundingClientRect().top, moved: false };
    // Captured from the press on: a quick drag leaves the small handle before
    // the first move event, which would then go to the remote screen instead.
    ref.current.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !ref.current) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < DRAG_PX) return;
    d.moved = true;
    setTop(clampTop(d.startTop + dy, ref.current.offsetHeight));
  }, []);

  const onPointerUp = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    suppressClick.current = true;
    const t = ref.current?.getBoundingClientRect().top;
    if (t !== undefined) {
      try { localStorage.setItem(storageKey, String(Math.round(t))); } catch { /* storage unavailable */ }
    }
  }, [storageKey]);

  // The click that ends a drag must not also open the panel.
  const onClickCapture = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // A callback ref, so the caller gets no ref object to read during render.
  const setRef = useCallback((node: HTMLButtonElement | null) => { ref.current = node; }, []);

  const style: CSSProperties | undefined = top === null ? undefined : { top, transform: "none" };
  return { attach: setRef, style, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClickCapture } };
}
