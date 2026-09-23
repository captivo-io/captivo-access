/* eslint-disable @typescript-eslint/no-explicit-any */
// Touch support for a Guacamole gateway session: single finger emulates the
// mouse (tap = click, long-press = right-click, drag = move) via
// Guacamole.Mouse.Touchscreen; two fingers pinch-zoom and pan a wrapper around
// the display (a client-side transform, never sent to the remote). Desktop
// pointer input keeps using Guacamole.Mouse unchanged — this only runs on touch.
import { applyGesture, toggleZoom, toCss, IDENTITY, type Transform, type TwoFinger } from "@/lib/session/pinch-zoom";

function centroid(t: TouchList): TwoFinger {
  const a = t[0], b = t[1];
  const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
  const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
  return { cx, cy, dist: Math.hypot(dx, dy) };
}

export interface TouchController {
  destroy: () => void;
  reset: () => void;
  onZoomChange: (cb: (zoomed: boolean) => void) => void;
}

// stage: the wrapper we transform. element: the guac display element (child of
// stage) that Touchscreen listens on. Guacamole computes touch coordinates from
// the element's bounding rect, which already reflects the wrapper transform, so
// clicks stay accurate at any zoom.
export function setupGatewayTouch(Guacamole: any, client: any, stage: HTMLElement, element: HTMLElement): TouchController {
  const touchscreen = new Guacamole.Mouse.Touchscreen(element);
  const sendState = (state: any) => { try { client.getDisplay().showCursor(true); } catch { /* noop */ } client.sendMouseState(state, true); };
  touchscreen.onEach?.(["mousedown", "mousemove", "mouseup"], (e: any) => sendState(e.state));

  let t: Transform = IDENTITY;
  let gesturing = false;
  let last: TwoFinger | null = null;
  const vp = () => ({ width: window.innerWidth, height: window.innerHeight });
  let zoomCb: ((z: boolean) => void) | null = null;
  const apply = () => { stage.style.transform = toCss(t); stage.style.transformOrigin = "center center"; zoomCb?.(t.scale > 1.01); };
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

  const onStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      // Two fingers: take over from Touchscreen for this gesture.
      e.preventDefault(); e.stopPropagation();
      gesturing = true;
      last = centroid(e.touches);
    } else if (e.touches.length === 1 && t.scale <= 1.01) {
      // Double-tap to zoom (only when not already zoomed, so single taps click).
      const now = Date.now(), x = e.touches[0].clientX, y = e.touches[0].clientY;
      if (now - lastTapTime < 300 && Math.hypot(x - lastTapX, y - lastTapY) < 30) {
        e.preventDefault(); e.stopPropagation();
        t = toggleZoom(t, x, y, vp()); apply();
        lastTapTime = 0;
      } else { lastTapTime = now; lastTapX = x; lastTapY = y; }
    }
  };
  const onMove = (e: TouchEvent) => {
    if (!gesturing || e.touches.length !== 2 || !last) return;
    e.preventDefault(); e.stopPropagation();
    const cur = centroid(e.touches);
    t = applyGesture(t, last, cur, vp());
    last = cur;
    apply();
  };
  const onEnd = (e: TouchEvent) => {
    if (gesturing && e.touches.length < 2) { gesturing = false; last = null; if (e.cancelable) e.preventDefault(); e.stopPropagation(); }
  };

  // Capture phase on the stage: fires before Touchscreen's listeners on the
  // element (bubble phase), so a two-finger gesture is intercepted while single
  // touches fall through to Touchscreen untouched.
  stage.addEventListener("touchstart", onStart, { capture: true, passive: false });
  stage.addEventListener("touchmove", onMove, { capture: true, passive: false });
  stage.addEventListener("touchend", onEnd, { capture: true, passive: false });
  stage.addEventListener("touchcancel", onEnd, { capture: true, passive: false });

  return {
    destroy: () => {
      stage.removeEventListener("touchstart", onStart, { capture: true } as any);
      stage.removeEventListener("touchmove", onMove, { capture: true } as any);
      stage.removeEventListener("touchend", onEnd, { capture: true } as any);
      stage.removeEventListener("touchcancel", onEnd, { capture: true } as any);
      touchscreen.onEach?.(["mousedown", "mousemove", "mouseup"], () => {});
    },
    reset: () => { t = IDENTITY; apply(); },
    onZoomChange: (cb) => { zoomCb = cb; },
  };
}
