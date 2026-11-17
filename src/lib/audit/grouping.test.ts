import { describe, it, expect } from "vitest";
import { groupBursts, mergeAdminRows, describeAgent } from "./grouping";

const ev = (id: string, min: number, over: Partial<{ userId: string; siteId: string; clientIp: string; method: string; decision: "ALLOW" | "DENY" }> = {}) => ({
  id, timestamp: new Date(Date.UTC(2026, 10, 18, 12, 0) - min * 60_000).toISOString(),
  userId: "u1", userEmail: "a@x", siteId: "s1", host: "h", clientIp: "1.1.1.1", method: "GET", decision: "ALLOW" as const, ...over,
});

describe("groupBursts", () => {
  it("groups consecutive events by person, resource and IP", () => {
    const b = groupBursts([ev("1", 0), ev("2", 1, { decision: "DENY" }), ev("3", 2, { method: "UPLOAD" }), ev("4", 3, { siteId: "s2" })]);
    expect(b.map((x) => x.rows.map((r) => r.id))).toEqual([["1", "2", "3"], ["4"]]);
    expect(b[0]).toMatchObject({ id: "1", denied: 1, files: 1, end: ev("1", 0).timestamp, start: ev("3", 2).timestamp });
  });
  it("breaks on a gap longer than five minutes", () => {
    expect(groupBursts([ev("1", 0), ev("2", 4), ev("3", 10)]).map((x) => x.rows.length)).toEqual([2, 1]);
  });
  it("starts a new burst when the IP changes", () => {
    expect(groupBursts([ev("1", 0), ev("2", 1, { clientIp: "2.2.2.2" })])).toHaveLength(2);
  });
});

describe("mergeAdminRows", () => {
  const a = (id: string, sec: number, action = "recording.erasure_requested", actorEmail = "x@y") =>
    ({ id, timestamp: new Date(Date.UTC(2026, 10, 18, 12, 0) - sec * 1000).toISOString(), action, actorEmail });
  it("merges the same action by the same admin within a minute", () => {
    expect(mergeAdminRows([a("1", 0), a("2", 20), a("3", 59), a("4", 61)]).map((g) => g.length)).toEqual([3, 1]);
  });
  it("keeps different actions and admins apart", () => {
    expect(mergeAdminRows([a("1", 0), a("2", 1, "grant.revoke"), a("3", 2, "grant.revoke", "z@y")])).toHaveLength(3);
  });
});

describe("describeAgent", () => {
  it("names the browser and the OS", () => {
    expect(describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")).toBe("Chrome · Windows");
    expect(describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15")).toBe("Safari · macOS");
    expect(describeAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131 Safari/537.36 Edg/131")).toBe("Edge · Windows");
    expect(describeAgent("curl/8.5.0")).toBe("curl");
  });
  it("returns null for nothing useful", () => {
    expect(describeAgent(null)).toBeNull();
    expect(describeAgent("Go-http-client/1.1")).toBeNull();
  });
});
