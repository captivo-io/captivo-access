import { describe, it, expect } from "vitest";
import { mergeActivity, type ActivityItem } from "./activity-feed";

const item = (id: string, iso: string): ActivityItem => ({
  id, at: new Date(iso), kind: "access.allow", text: id, tone: "ok", category: "session",
});

describe("mergeActivity", () => {
  it("merges sources newest-first and caps at the limit", () => {
    const access = [item("a1", "2026-08-14T10:00:00Z"), item("a2", "2026-08-14T08:00:00Z")];
    const admin = [item("m1", "2026-08-14T11:00:00Z"), item("m2", "2026-08-14T09:00:00Z")];
    const recs = [item("r1", "2026-08-14T07:00:00Z")];

    const feed = mergeActivity([access, admin, recs], 3);

    expect(feed.map((f) => f.id)).toEqual(["m1", "a1", "m2"]);
  });

  it("returns everything sorted when under the limit", () => {
    const feed = mergeActivity([[item("x", "2026-08-14T01:00:00Z")], [item("y", "2026-08-14T02:00:00Z")]], 10);
    expect(feed.map((f) => f.id)).toEqual(["y", "x"]);
  });
});
