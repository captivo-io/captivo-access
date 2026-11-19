import { describe, expect, it } from "vitest";
import { parseCompactDur, sessionsFromAudit, withoutRecorded, type AuditSessionEvent, type SiteMode } from "./history-sessions";

const T0 = Date.parse("2026-11-19T10:00:00Z");
const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000);
const ev = (min: number, siteId: string, reason: string | null, path = "/guac-tunnel", sec = 0): AuditSessionEvent =>
  ({ at: at(min, sec), siteId, siteName: `name-${siteId}`, reason, path });
const modes: Record<string, SiteMode> = { rdp: "GATEWAY", iso: "ISOLATED", web: "TRANSPARENT" };
const modeOf = (id: string) => modes[id];

describe("parseCompactDur", () => {
  it("reads every format the data plane writes", () => {
    expect(parseCompactDur("42s")).toBe(42_000);
    expect(parseCompactDur("12m")).toBe(720_000);
    expect(parseCompactDur("1h05m")).toBe(3_900_000);
    expect(parseCompactDur("soon")).toBeNull();
  });
});

describe("sessionsFromAudit", () => {
  it("pairs a remote close with its open", () => {
    const s = sessionsFromAudit([ev(0, "rdp", "session_open", "/guac-tunnel", 20), ev(12, "rdp", "session_close 11m", "/guac-tunnel", 50)], modeOf);
    expect(s).toEqual([{ siteId: "rdp", siteName: "name-rdp", mode: "GATEWAY", native: false, startedAt: at(0, 20), endedAt: at(12, 50) }]);
  });

  it("keeps two sessions on the same resource apart", () => {
    const s = sessionsFromAudit([
      ev(0, "rdp", "session_open"), ev(1, "rdp", "session_open"),
      ev(3, "rdp", "session_close 2m"), ev(30, "rdp", "session_close 30m"),
    ], modeOf);
    expect(s.map((x) => [x.startedAt, x.endedAt])).toEqual([[at(1), at(3)], [at(0), at(30)]]);
  });

  it("marks native RDP and starts a close without its open from the duration", () => {
    const s = sessionsFromAudit([
      ev(5, "rdp", "session_open native_rdp", "/remoteDesktopGateway/"), ev(9, "rdp", "session_close 4m", "/remoteDesktopGateway/"),
      ev(20, "rdp", "session_close 15m", "/remoteDesktopGateway/"),
    ], modeOf);
    expect(s.map((x) => [x.native, x.startedAt])).toEqual([[true, at(5)], [true, at(5)]]);
  });

  it("leaves out a session that hasn't closed", () => {
    expect(sessionsFromAudit([ev(0, "iso", "session_open", "/kasm-tunnel/websockify")], modeOf)).toEqual([]);
  });

  it("makes web spans from the open to the last request before the next one", () => {
    const s = sessionsFromAudit([
      ev(0, "web", "session_open", "/"), ev(0, "web", null, "/"), ev(4, "web", "", "/app.js"),
      ev(6, "web", "session_close 5m", "/ws"), ev(6, "web", "file:image/png", "/x.png"),
      ev(30, "web", "session_open", "/"), ev(31, "web", null, "/"),
      ev(32, "other", null, "/"),
    ], modeOf);
    expect(s.map((x) => [x.siteId, x.startedAt, x.endedAt])).toEqual([["web", at(0), at(6)], ["web", at(30), at(31)]]);
  });

  it("guesses a deleted resource's kind from the path", () => {
    const s = sessionsFromAudit([ev(0, "gone", "session_open", "/kasm-tunnel/websockify"), ev(3, "gone", "session_close 3m", "/websockify")], modeOf);
    expect(s[0]).toMatchObject({ mode: "ISOLATED", siteName: "name-gone" });
  });
});

describe("withoutRecorded", () => {
  it("drops sessions a recording already shows", () => {
    const s = sessionsFromAudit([
      ev(0, "rdp", "session_open"), ev(10, "rdp", "session_close 10m"),
      ev(60, "rdp", "session_open"), ev(70, "rdp", "session_close 10m"),
    ], modeOf);
    const kept = withoutRecorded(s, [{ siteId: "rdp", startedAt: at(0, 5), endedAt: at(10) }, { siteId: "web", startedAt: at(60), endedAt: at(70) }]);
    expect(kept.map((x) => x.startedAt)).toEqual([at(60)]);
  });
});
