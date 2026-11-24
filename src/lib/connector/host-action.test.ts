import { describe, it, expect } from "vitest";
import { foldHostAction, liveHostAction, hostActionBusy, newHostActionId, remoteControl, storedHostAction, updateTarget, type StoredHostAction } from "./host-action";
import type { ConnectorTelemetry } from "./telemetry";

const tele = (extra: Partial<ConnectorTelemetry> = {}): ConnectorTelemetry => ({
  version: "2.41.0", uptimeSec: 1, activeConnections: 0, totalConnections: 0, deniedCount: 0, bytesIn: 0, bytesOut: 0, ...extra,
});

describe("remoteControl", () => {
  it("has no updater for a connector installed as a program", () => {
    expect(remoteControl(true, tele({ updater: { version: "2.41.0", dockerOk: true } }), undefined, Date.now(), "windows")).toEqual({ ok: false, reason: "program" });
    expect(remoteControl(false, tele(), undefined, Date.now(), "linux")).toEqual({ ok: false, reason: "offline" });
  });
  it("needs the connector online with a working updater", () => {
    expect(remoteControl(false, tele({ updater: { version: "2.41.0", dockerOk: true } }))).toEqual({ ok: false, reason: "offline" });
    expect(remoteControl(true, tele())).toEqual({ ok: false, reason: "no_updater" });
    expect(remoteControl(true, tele({ updater: { version: "2.41.0", dockerOk: false } }))).toEqual({ ok: false, reason: "no_docker" });
    expect(remoteControl(true, tele({ updater: { version: "2.41.0", dockerOk: true } }))).toEqual({ ok: true, updaterVersion: "2.41.0" });
  });
  it("says a newly paired connector's updater is still being installed", () => {
    const now = Date.parse("2026-11-23T18:00:00Z");
    expect(remoteControl(true, tele(), "2026-11-23T17:50:00Z", now)).toEqual({ ok: false, reason: "installing" });
    expect(remoteControl(true, tele(), "2026-11-23T17:30:00Z", now)).toEqual({ ok: false, reason: "no_updater" });
    expect(remoteControl(true, tele({ updater: { version: "2.58.1", dockerOk: true } }), "2026-11-23T17:59:00Z", now)).toEqual({ ok: true, updaterVersion: "2.58.1" });
  });
});

describe("updateTarget", () => {
  it("offers the manager's version only when it is newer and a plain release", () => {
    expect(updateTarget("2.40.0", "2.41.0")).toBe("2.41.0");
    expect(updateTarget("2.41.0", "2.41.0")).toBeNull();
    expect(updateTarget("2.42.0", "2.41.0")).toBeNull();
    expect(updateTarget("2.40.0", "dev")).toBeNull();
    expect(updateTarget("2.40.0", "2.41.0-rc1")).toBeNull();
    expect(updateTarget(null, "2.41.0")).toBeNull();
  });
});

describe("hostActionBusy", () => {
  it("is busy until a final state", () => {
    expect(hostActionBusy(null)).toBe(false);
    for (const s of ["waiting_idle", "preparing", "applying", "rolling_back", "removing"] as const) expect(hostActionBusy({ id: "a", action: "update", state: s })).toBe(true);
    for (const s of ["done", "rolled_back", "failed"] as const) expect(hostActionBusy({ id: "a", action: "update", state: s })).toBe(false);
  });
});

describe("foldHostAction", () => {
  const stored: StoredHostAction = { id: "act_1", action: "update", version: "2.41.0", by: "a@x", at: "2026-11-20T10:00:00Z", state: "sent", from: "2.40.0" };

  it("ignores another request's report and an already finished one", () => {
    expect(foldHostAction(stored, { id: "act_0", action: "update", state: "done" })).toBeNull();
    expect(foldHostAction({ ...stored, state: "done" }, { id: "act_1", action: "update", state: "failed" })).toBeNull();
    expect(foldHostAction(null, { id: "act_1", action: "update", state: "done" })).toBeNull();
  });

  it("tracks progress silently and notes the outcome once", () => {
    const a = foldHostAction(stored, { id: "act_1", action: "update", state: "applying", from: "2.40.0" });
    expect(a?.next.state).toBe("applying");
    expect(a?.event).toBeNull();
    expect(foldHostAction(a!.next, { id: "act_1", action: "update", state: "applying" })).toBeNull();
    const b = foldHostAction(a!.next, { id: "act_1", action: "update", state: "rolled_back", detail: "2.41.0 did not connect within 4 minutes" });
    expect(b?.event).toEqual({ level: "warn", text: "Update to 2.41.0 rolled back: 2.41.0 did not connect within 4 minutes" });
    expect(foldHostAction(b!.next, { id: "act_1", action: "update", state: "rolled_back" })).toBeNull();
    expect(foldHostAction(stored, { id: "act_1", action: "update", state: "done" })?.event).toEqual({ level: "ok", text: "Updated from the console to 2.41.0" });
    expect(foldHostAction(stored, { id: "act_1", action: "update", state: "failed", detail: "x" })?.event?.level).toBe("bad");
  });
});

describe("ids and stored values", () => {
  it("makes ids the connector accepts", () => {
    const id = newHostActionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newHostActionId()).not.toBe(id);
  });
  it("reads only a well-formed stored value", () => {
    expect(storedHostAction(null)).toBeNull();
    expect(storedHostAction({ id: 1 })).toBeNull();
    expect(storedHostAction({ id: "a", action: "reboot" })).toBeNull();
    expect(storedHostAction({ id: "a", action: "update", by: "x", at: "t", state: "sent" })?.id).toBe("a");
  });
});

describe("liveHostAction", () => {
  const now = new Date("2026-11-20T10:01:00Z");
  const sent: StoredHostAction = { id: "act_2", action: "update", version: "2.41.1", by: "a@x", at: "2026-11-20T10:00:30Z", state: "sent" };
  it("stands in for a request the connector has not reported yet", () => {
    expect(liveHostAction(null, sent, now)).toMatchObject({ id: "act_2", state: "preparing", version: "2.41.1" });
    expect(liveHostAction({ id: "act_1", action: "update", state: "done" }, sent, now)?.id).toBe("act_2");
    expect(liveHostAction(null, { ...sent, waitIdle: true }, now)?.state).toBe("waiting_idle");
  });
  it("prefers the connector's own report, and gives up on a stale request", () => {
    expect(liveHostAction({ id: "act_2", action: "update", state: "applying" }, sent, now)?.state).toBe("applying");
    expect(liveHostAction(null, sent, new Date("2026-11-20T10:10:00Z"))).toBeNull();
    expect(liveHostAction(null, { ...sent, state: "done" }, now)).toBeNull();
  });
});
