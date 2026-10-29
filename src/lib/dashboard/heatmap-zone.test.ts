import { describe, it, expect } from "vitest";
import { heatmapInZone, zoneOffsetMinutes } from "./heatmap-zone";

const AT = new Date("2026-10-29T12:00:00Z");
const grid = () => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));

describe("traffic heatmap in the viewer's zone", () => {
  it("knows the zone offsets", () => {
    expect(zoneOffsetMinutes("Europe/Istanbul", AT)).toBe(180);
    expect(zoneOffsetMinutes("America/New_York", AT)).toBe(-240);
    expect(zoneOffsetMinutes("Asia/Kolkata", AT)).toBe(330);
  });

  it("moves a Saturday 22:00 UTC count to Sunday 01:00 in Istanbul", () => {
    const g = grid(); g[6]![22] = 5;
    const out = heatmapInZone(g, "Europe/Istanbul", AT)!;
    expect(out[0]![1]).toBe(5);
    expect(out.flat().reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("moves a Sunday 02:00 UTC count back to Saturday 22:00 in New York", () => {
    const g = grid(); g[0]![2] = 3;
    expect(heatmapInZone(g, "America/New_York", AT)![6]![22]).toBe(3);
  });

  it("stays in UTC for a part-hour zone, UTC itself, or an unknown zone", () => {
    expect(heatmapInZone(grid(), "Asia/Kolkata", AT)).toBeNull();
    expect(heatmapInZone(grid(), "UTC", AT)).toBeNull();
    expect(heatmapInZone(grid(), null, AT)).toBeNull();
    expect(heatmapInZone(grid(), "Mars/Olympus", AT)).toBeNull();
  });
});
