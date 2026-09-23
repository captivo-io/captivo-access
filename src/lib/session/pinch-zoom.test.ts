import { describe, it, expect } from "vitest";
import { applyGesture, clampScale, clampPan, toggleZoom, IDENTITY, type Transform } from "./pinch-zoom";

const VP = { width: 1000, height: 800 };

describe("pinch-zoom", () => {
  it("clamps scale to [1,4]", () => {
    expect(clampScale(0.5)).toBe(1);
    expect(clampScale(9)).toBe(4);
    expect(clampScale(2)).toBe(2);
  });
  it("pins pan at scale 1 and bounds it above", () => {
    expect(clampPan({ scale: 1, x: 50, y: 50 }, VP)).toEqual({ scale: 1, x: 0, y: 0 });
    const c = clampPan({ scale: 2, x: 9999, y: -9999 }, VP);
    expect(c.x).toBe(500); expect(c.y).toBe(-400);
  });
  it("zooms in when fingers spread, out when they pinch", () => {
    const spread = applyGesture(IDENTITY, { cx: 500, cy: 400, dist: 100 }, { cx: 500, cy: 400, dist: 200 }, VP);
    expect(spread.scale).toBe(2);
    const pinch = applyGesture(spread, { cx: 500, cy: 400, dist: 200 }, { cx: 500, cy: 400, dist: 100 }, VP);
    expect(pinch.scale).toBe(1);
  });
  it("double-tap toggles 1x <-> 2x centred on the tap", () => {
    const z = toggleZoom(IDENTITY, 700, 400, VP);
    expect(z.scale).toBe(2);
    expect(z.x).toBe(-200); // -(700-500)
    expect(toggleZoom(z as Transform, 700, 400, VP)).toEqual(IDENTITY);
  });
});
