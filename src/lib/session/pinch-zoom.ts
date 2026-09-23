// Pure pinch-zoom + pan math for a session stage. The DOM controller feeds it
// two-finger gestures; it returns the CSS transform (scale + translate) to apply
// to a wrapper around the remote display. Unit-tested; no DOM here.

export interface Transform { scale: number; x: number; y: number }
export const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export interface Viewport { width: number; height: number }

export interface TwoFinger { cx: number; cy: number; dist: number } // centroid + finger distance, in px

const MIN_SCALE = 1;
const MAX_SCALE = 4;

export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

// Keep the scaled content covering the viewport: at scale 1 it is pinned (no
// pan); above 1 the translate is bounded so edges never leave a gap.
export function clampPan(t: Transform, vp: Viewport): Transform {
  if (t.scale <= 1) return { scale: t.scale, x: 0, y: 0 };
  const maxX = (vp.width * (t.scale - 1)) / 2;
  const maxY = (vp.height * (t.scale - 1)) / 2;
  return { scale: t.scale, x: Math.max(-maxX, Math.min(maxX, t.x)), y: Math.max(-maxY, Math.min(maxY, t.y)) };
}

// Update the transform from a two-finger move: `from`→`to` between frames.
// Scaling is anchored at the gesture centroid so the pinch feels natural, and
// the centroid translation pans.
export function applyGesture(prev: Transform, from: TwoFinger, to: TwoFinger, vp: Viewport): Transform {
  const ratio = from.dist > 0 ? to.dist / from.dist : 1;
  const scale = clampScale(prev.scale * ratio);
  const k = scale / prev.scale;
  // Anchor: the point under the centroid stays put as we scale, then add the
  // centroid's own movement as a pan.
  const ax = vp.width / 2, ay = vp.height / 2;
  const x = k * (prev.x - (from.cx - ax)) + (to.cx - ax);
  const y = k * (prev.y - (from.cy - ay)) + (to.cy - ay);
  return clampPan({ scale, x, y }, vp);
}

// Double-tap: toggle between 1x and 2x, centred on the tap point.
export function toggleZoom(prev: Transform, tapX: number, tapY: number, vp: Viewport): Transform {
  if (prev.scale > 1.01) return IDENTITY;
  const scale = 2;
  const ax = vp.width / 2, ay = vp.height / 2;
  return clampPan({ scale, x: -(tapX - ax), y: -(tapY - ay) }, vp);
}

export function toCss(t: Transform): string {
  return `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) scale(${t.scale.toFixed(3)})`;
}
