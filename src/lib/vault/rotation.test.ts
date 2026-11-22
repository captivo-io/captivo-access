import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/connector/history", () => ({ recordConnectorEvent: vi.fn() }));
vi.mock("@/lib/mobile/push", () => ({ pushToCapability: vi.fn() }));
vi.mock("@/lib/tenant/console-url", () => ({ consoleBaseUrl: async () => "" }));

import { acceptPrepared, canRotate, nextScheduled, planJob, retryDelayMs, rotationMethod, runJob, type RotationJob } from "./rotation";
import { planCopy } from "./reconcile-reshare";

const SEAL = (n: number) => "cv1:" + Buffer.alloc(60, n).toString("base64");
const conn = (id: string, over: Partial<{ status: string; version: string | null; vaultPublicKey: string | null }> = {}) => ({ id, name: id.toUpperCase(), status: "ONLINE", version: "2.45.0", vaultPublicKey: `k-${id}`, ...over });
const NOW = new Date("2026-11-21T12:00:00Z");

function row(over: Record<string, unknown> = {}) {
  return {
    id: "vc1", secret: SEAL(1), sealedTo: "k-a", extraSeals: { "k-b": SEAL(2) }, protocol: "SSH", secretKind: "PASSWORD",
    targetHost: "10.0.0.7", targetPort: 22, username: "alice", guacParams: null,
    rotateAfterSession: true, rotateEveryDays: null, rotateVerifyDaily: false, rotateDueAt: new Date(NOW.getTime() - 1000), rotatedAt: null, verifiedAt: null,
    rotationFailures: 0, pendingSeals: null, sshHostKey: null, reconcileUsername: null, reconcileKind: null, reconcileSeals: null,
    site: { id: "s1", name: "Build", connector: conn("a"), connectorGroup: { members: [{ connector: conn("a") }, { connector: conn("b", { version: "2.44.0" }) }] } },
    ...over,
  } as never;
}

describe("rotationMethod", () => {
  it("rotates SSH passwords and directory accounts over an encrypted connection only", () => {
    expect(rotationMethod({ protocol: "SSH", secretKind: "PASSWORD" }, null)).toEqual({ method: "linux" });
    expect(rotationMethod({ protocol: "SSH", secretKind: "KEY" }, null)).toHaveProperty("unsupported");
    expect(rotationMethod({ protocol: "VNC", secretKind: "PASSWORD" }, null)).toHaveProperty("unsupported");
    const dir = { enabled: true, host: "dc1", port: 636, security: "LDAPS", caCertPem: "", insecureSkipVerify: false, baseDN: "DC=x", resetUsername: "", resetSeals: null };
    expect(rotationMethod({ protocol: "RDP", secretKind: "PASSWORD" }, dir)).toEqual({ method: "ad" });
    expect(rotationMethod({ protocol: "RDP", secretKind: "PASSWORD" }, { ...dir, security: "PLAIN" })).toHaveProperty("unsupported");
    expect(rotationMethod({ protocol: "RDP", secretKind: "PASSWORD" }, null)).toHaveProperty("unsupported");
  });
});

describe("scheduling", () => {
  it("backs off 5 min, 15 min, 1 h, then 6 h", () => {
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([300_000, 900_000, 3_600_000, 21_600_000, 21_600_000]);
  });
  it("schedules from the last rotation, never in the past", () => {
    expect(nextScheduled({ rotateEveryDays: null, rotatedAt: NOW }, NOW)).toBeNull();
    expect(nextScheduled({ rotateEveryDays: 30, rotatedAt: NOW }, NOW)?.toISOString()).toBe("2026-12-21T12:00:00.000Z");
    expect(nextScheduled({ rotateEveryDays: 7, rotatedAt: new Date("2026-01-01") }, NOW)).toEqual(NOW);
  });
  it("lets only online connectors on 2.45.0 or later rotate", () => {
    expect(canRotate({ status: "ONLINE", version: "2.45.0" })).toBe(true);
    expect(canRotate({ status: "ONLINE", version: "2.44.1" })).toBe(false);
    expect(canRotate({ status: "OFFLINE", version: "2.45.0" })).toBe(false);
  });
});

describe("planJob", () => {
  it("has a connector that can rotate do it, sealing the next password to every member", () => {
    const j = planJob(row(), null, NOW) as RotationJob;
    expect(j.op).toBe("apply");
    expect(j.connector.id).toBe("a");
    expect(j.recipients).toEqual(["k-a", "k-b"]);
  });
  it("waits when no connector is new enough, and is quiet when nothing is due", () => {
    const old = row({ site: { id: "s1", name: "Build", connector: conn("a", { version: "2.44.0" }), connectorGroup: null } });
    expect(planJob(old, null, NOW)).toHaveProperty("reason");
    expect(planJob(row({ rotateDueAt: null }), null, NOW)).toBeNull();
  });
  it("picks a connector that holds the pending seal when one is pending", () => {
    const j = planJob(row({ pendingSeals: { "k-b": SEAL(5) }, site: { id: "s1", name: "B", connector: conn("a"), connectorGroup: { members: [{ connector: conn("a") }, { connector: conn("b") }] } } }), null, NOW) as RotationJob;
    expect(j.connector.id).toBe("b");
  });
  it("plans a daily check when only that is due", () => {
    const j = planJob(row({ rotateDueAt: null, rotateVerifyDaily: true, verifiedAt: new Date(NOW.getTime() - 2 * 86_400_000) }), null, NOW) as RotationJob;
    expect(j.op).toBe("verify");
  });
});

describe("runJob", () => {
  const job = () => planJob(row(), null, NOW) as RotationJob;
  it("never starts under a session, or when the data plane cannot say", async () => {
    const call = vi.fn();
    expect(await runJob(job(), async (fn) => fn(), { call, liveSites: async () => new Set(["s1"]) })).toEqual({ kind: "busy" });
    expect(await runJob(job(), async (fn) => fn(), { call, liveSites: async () => null })).toEqual({ kind: "busy" });
    expect(call).not.toHaveBeenCalled();
  });
  it("accepts only a complete set of prepared seals", () => {
    const j = job();
    expect(acceptPrepared(j, { "k-a": SEAL(7) })).toBeNull();
    expect(acceptPrepared(j, { "k-a": SEAL(7), "k-b": "plain" })).toBeNull();
    expect(acceptPrepared(j, { "k-a": SEAL(7), "k-b": SEAL(8), "k-evil": SEAL(9) })).toEqual({ "k-a": SEAL(7), "k-b": SEAL(8) });
  });
});

describe("reconcile account copies", () => {
  it("are given by a member on a rotating release to members without one", () => {
    expect(planCopy({ "k-a": SEAL(1) }, [conn("a"), conn("b"), conn("r", { status: "REVOKED" })])).toEqual({ source: { id: "a", name: "A" }, sourceKey: "k-a", to: { "k-b": { id: "b", name: "B" } } });
    expect(planCopy({ "k-a": SEAL(1) }, [conn("a", { version: "2.44.0" }), conn("b")])).toBeNull();
    expect(planCopy({ "k-a": SEAL(1), "k-b": SEAL(2) }, [conn("a"), conn("b")])).toBeNull();
  });
});
