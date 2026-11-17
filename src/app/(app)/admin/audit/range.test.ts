import { describe, it, expect } from "vitest";
import { parseRange, resolveRange } from "./range";

const now = new Date("2026-11-18T12:00:00Z");

describe("range", () => {
  it("defaults to the last 24 hours", () => {
    expect(parseRange(undefined)).toBe("24h");
    expect(parseRange("bogus")).toBe("24h");
    expect(resolveRange("24h", null, null, now).from.toISOString()).toBe("2026-11-17T12:00:00.000Z");
  });
  it("uses the given ends for a custom range, in order", () => {
    const r = resolveRange("custom", "2026-11-18T10:00:00Z", "2026-11-01T00:00:00Z", now);
    expect(r.from.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-18T10:00:00.000Z");
  });
  it("falls back to a day ending now when a custom end is missing", () => {
    expect(resolveRange("custom", null, null, now).to).toEqual(now);
  });
});
