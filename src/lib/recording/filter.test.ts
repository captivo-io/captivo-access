import { describe, it, expect } from "vitest";
import { buildRecordingWhere, parseRecordingFilter, recordingType } from "./filter";

describe("buildRecordingWhere", () => {
  it("filters by userId and siteId", () => {
    const w = buildRecordingWhere({ userId: "u1", siteId: "s1", limit: 50, offset: 0 });
    expect(w.userId).toBe("u1");
    expect(w.siteId).toBe("s1");
  });
  it("builds a startedAt range from from/to", () => {
    const from = new Date("2026-08-01"); const to = new Date("2026-08-08");
    const w = buildRecordingWhere({ from, to, limit: 50, offset: 0 });
    expect(w.startedAt).toEqual({ gte: from, lte: to });
  });
  it("matches q against the host and the resources and people found by name", () => {
    const w = buildRecordingWhere({ q: "prox", limit: 50, offset: 0 }, { siteIds: ["s1"], userIds: [] });
    expect(w.AND).toEqual([{ OR: [{ host: { contains: "prox", mode: "insensitive" } }, { siteId: { in: ["s1"] } }] }]);
  });
  it("ignores q shorter than 2 chars", () => {
    const w = buildRecordingWhere({ q: "p", limit: 50, offset: 0 });
    expect(w.AND).toBeUndefined();
  });
  it("filters by type and empty sessions", () => {
    expect(buildRecordingWhere({ type: "web", limit: 50, offset: 0 }).format).toEqual({ in: ["RRWEB", "VIDEO"] });
    expect(buildRecordingWhere({ type: "ssh", limit: 50, offset: 0 })).toMatchObject({ format: "GUAC", protocol: { in: ["ssh", "telnet"] } });
    const rdp = buildRecordingWhere({ type: "rdp", limit: 50, offset: 0 });
    expect(rdp.format).toBe("GUAC");
    expect(rdp.AND).toEqual([{ OR: [{ protocol: null }, { protocol: { notIn: ["ssh", "telnet"] } }] }]);
    expect(buildRecordingWhere({ empty: true, limit: 50, offset: 0 }).durationMs).toEqual({ lt: 1000 });
  });
});

describe("parseRecordingFilter", () => {
  const opts = { defaultLimit: 50, maxLimit: 200 };
  it("clamps limit to maxLimit and floors offset", () => {
    const f = parseRecordingFilter(new URLSearchParams("limit=9999&offset=10.7"), opts);
    expect(f.limit).toBe(200);
    expect(f.offset).toBe(10);
  });
  it("defaults limit and offset when absent", () => {
    const f = parseRecordingFilter(new URLSearchParams(""), opts);
    expect(f.limit).toBe(50);
    expect(f.offset).toBe(0);
  });
  it("parses valid dates and drops invalid ones", () => {
    const f = parseRecordingFilter(new URLSearchParams("from=2026-08-01&to=bad"), opts);
    expect(f.from).toBeInstanceOf(Date);
    expect(f.to).toBeUndefined();
  });
  it("parses and trims cmd", () => {
    const f = parseRecordingFilter(new URLSearchParams("cmd=%20%20rm%20-rf%20%20"), opts);
    expect(f.cmd).toBe("rm -rf");
  });
  it("cmd absent → undefined", () => {
    const f = parseRecordingFilter(new URLSearchParams(""), opts);
    expect(f.cmd).toBeUndefined();
  });
});

describe("recordingType", () => {
  it("files each recording under its tab", () => {
    expect(recordingType({ format: "RRWEB", protocol: null })).toBe("web");
    expect(recordingType({ format: "VIDEO", protocol: "isolated" })).toBe("web");
    expect(recordingType({ format: "GUAC", protocol: "ssh" })).toBe("ssh");
    expect(recordingType({ format: "GUAC", protocol: "vnc" })).toBe("rdp");
    expect(recordingType({ format: "GUAC", protocol: null })).toBe("rdp");
  });
  it("parses type and empty from the query", () => {
    expect(parseRecordingFilter(new URLSearchParams("type=ssh&empty=1"), { defaultLimit: 50, maxLimit: 200 })).toMatchObject({ type: "ssh", empty: true });
    expect(parseRecordingFilter(new URLSearchParams("type=ftp"), { defaultLimit: 50, maxLimit: 200 }).type).toBeUndefined();
  });
});
