import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { histogramPlan, fillHistogram } from "./histogram";

const H = 3_600_000;
const to = new Date("2026-11-18T12:00:00Z");

describe("histogramPlan", () => {
  it("uses 5-minute bars for the last hour", () => {
    expect(histogramPlan(new Date(to.getTime() - H), to)).toMatchObject({ widthMs: 300_000, count: 12, start: to.getTime() - H });
  });
  it("uses hourly bars for a day and 6-hour bars for a week", () => {
    expect(histogramPlan(new Date(to.getTime() - 24 * H), to)).toMatchObject({ widthMs: H, count: 24 });
    expect(histogramPlan(new Date(to.getTime() - 7 * 24 * H), to)).toMatchObject({ widthMs: 6 * H, count: 28 });
  });
  it("splits a long custom range into about 24 bars", () => {
    const p = histogramPlan(new Date(to.getTime() - 30 * 24 * H), to);
    expect(p.count).toBe(24);
    expect(p.start + p.count * p.widthMs).toBe(to.getTime());
  });
});

describe("fillHistogram", () => {
  it("sums rows into allow and deny series and clamps the last bar", () => {
    const plan = { start: 0, widthMs: H, count: 3 };
    const h = fillHistogram(plan, [
      { b: 0, decision: "ALLOW", n: 4n }, { b: 2, decision: "DENY", n: 1n },
      { b: 3, decision: "ALLOW", n: 2 }, { b: -1, decision: "ALLOW", n: 9 },
    ]);
    expect(h.allow).toEqual([4, 0, 2]);
    expect(h.deny).toEqual([0, 0, 1]);
  });
});
