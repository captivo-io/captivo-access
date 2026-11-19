import { describe, expect, it } from "vitest";
import { durationText, matches, summarize, type HistoryRowJSON } from "./history-view";

const row = (name: string, durationMs: number, kind: "web" | "remote" = "remote"): HistoryRowJSON => ({
  id: `${name}-${durationMs}`, siteId: "s", name, kind, proto: kind === "web" ? "HTTPS" : "RDP", via: null,
  startedAt: "2026-11-19T10:00:00Z", endedAt: "2026-11-19T10:01:00Z", durationMs, tile: null, href: null,
});

describe("durationText", () => {
  it("shows <1m under a minute instead of 0m", () => {
    expect(durationText(0)).toBe("<1m");
    expect(durationText(59_999)).toBe("<1m");
  });
  it("rounds to minutes, then hours and minutes", () => {
    expect(durationText(60_000)).toBe("1m");
    expect(durationText(31 * 60_000 + 20_000)).toBe("31m");
    expect(durationText(89 * 60_000)).toBe("1h 29m");
    expect(durationText(120 * 60_000)).toBe("2h 0m");
  });
});

describe("summarize", () => {
  it("counts, totals and picks the most used resource", () => {
    const s = summarize([row("WIN-SK", 60_000), row("WP-SSH", 30_000), row("WIN-SK", 120_000)]);
    expect(s).toEqual({ count: 3, totalMs: 210_000, top: { name: "WIN-SK", count: 2 } });
  });
  it("breaks a tie toward the newest", () => {
    expect(summarize([row("B", 1), row("A", 1)]).top?.name).toBe("B");
  });
  it("is empty without rows", () => {
    expect(summarize([])).toEqual({ count: 0, totalMs: 0, top: null });
  });
});

describe("matches", () => {
  it("filters by kind and by name, case-insensitively", () => {
    const r = row("WP-HTTP", 1000, "web");
    expect(matches(r, "", "all")).toBe(true);
    expect(matches(r, "", "remote")).toBe(false);
    expect(matches(r, "wp-h", "web")).toBe(true);
    expect(matches(r, "ssh", "all")).toBe(false);
  });
});
