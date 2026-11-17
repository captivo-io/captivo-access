import { describe, expect, it } from "vitest";
import { pushSpark, summarizeUptime, SPARK_LENGTH } from "./history";

const now = new Date("2026-11-17T12:00:00Z");

describe("summarizeUptime", () => {
  it("lays out 30 days ending today, unsampled days as no data", () => {
    const u = summarizeUptime([], now);
    expect(u.days).toHaveLength(30);
    expect(u.days[29].date).toBe("2026-11-17");
    expect(u.days[0].date).toBe("2026-10-19");
    expect(u.days.every((d) => d.state === "none")).toBe(true);
    expect(u.pct).toBeNull();
  });

  it("grades a day by its downtime and totals the window", () => {
    const u = summarizeUptime(
      [
        { day: "2026-11-17", samples: 100, online: 100 },
        { day: "2026-11-16", samples: 288, online: 285 }, // 15 min down
        { day: "2026-11-15", samples: 288, online: 200 }, // 7h20m down
        { day: "2026-11-14", samples: 10, online: 0 },
      ],
      now,
    );
    expect(u.days.slice(-4).map((d) => d.state)).toEqual(["bad", "bad", "warn", "ok"]);
    expect(u.days[28].minutes).toBe(15);
    expect(u.downtimeMin).toBe((3 + 88 + 10) * 5);
    expect(u.pct).toBeCloseTo((585 / 686) * 100, 5);
  });

  it("ignores rows outside the window", () => {
    expect(summarizeUptime([{ day: "2026-09-01", samples: 5, online: 0 }], now).pct).toBeNull();
  });
});

describe("pushSpark", () => {
  it("keeps the last bars only", () => {
    const s = Array.from({ length: SPARK_LENGTH }, (_, i) => i);
    expect(pushSpark(s, 99)).toEqual([...s.slice(1), 99]);
    expect(pushSpark([], 3)).toEqual([3]);
  });
});
