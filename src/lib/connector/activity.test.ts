import { describe, it, expect } from "vitest";
import { mergeActivity, type ActivityEvent } from "./activity";

const ev = (id: string, at: string, over: Partial<ActivityEvent> = {}): ActivityEvent =>
  ({ id, at, user: "ayse@vendor.example", siteId: "s1", siteName: "pfsense", method: "GET", path: "/", allow: true, ...over });

describe("mergeActivity", () => {
  it("folds identical requests within the same minute", () => {
    const rows = mergeActivity([
      ev("a", "2026-11-18T10:01:59.000Z"), ev("b", "2026-11-18T10:01:30.000Z"), ev("c", "2026-11-18T10:01:02.000Z"),
      ev("d", "2026-11-18T10:00:59.000Z"),
      ev("e", "2026-11-18T10:01:10.000Z", { allow: false }),
      ev("f", "2026-11-18T10:01:10.000Z", { path: "/api" }),
    ]);
    expect(rows.map((r) => [r.id, r.count])).toEqual([["a", 3], ["d", 1], ["e", 1], ["f", 1]]);
  });
  it("keeps the newest rows up to the limit", () => {
    const rows = mergeActivity(Array.from({ length: 5 }, (_, i) => ev(String(i), `2026-11-18T10:0${i}:00.000Z`)), 3);
    expect(rows.map((r) => r.id)).toEqual(["0", "1", "2"]);
  });
});
