import { describe, it, expect } from "vitest";
import { ELEVATE_MIN_CONNECTOR, ELEVATE_SESSIONS_MIN_CONNECTOR, elevationPlan, elevationPlatform, elevationProblem } from "@/lib/vault/elevation";

const linux = { protocol: "SSH", nativeSsh: true, nativeRdp: false, recorded: true, account: "root", username: "deploy" };
const win = { protocol: "RDP", nativeSsh: false, nativeRdp: true, recorded: true, account: "Administrator", username: "alice", windowsLocal: true };

describe("administrator rights during sessions: what a resource needs", () => {
  it("is for a Linux account or a local Windows account, with an administrator account", () => {
    expect(elevationProblem(linux)).toBeNull();
    expect(elevationProblem(win)).toBeNull();
    expect(elevationProblem({ ...linux, protocol: "VNC" })).toBe("elevate_ssh_only");
    expect(elevationProblem({ ...linux, account: null })).toBe("elevate_needs_account");
    expect(elevationProblem({ ...win, account: null })).toBe("elevate_needs_account");
    expect(elevationPlatform("SSH")).toBe("linux");
    expect(elevationPlatform("rdp")).toBe("windows");
    expect(elevationPlatform("POSTGRES")).toBeNull();
  });

  it("covers browser sessions without recording, and wants recording only for a native client", () => {
    expect(elevationProblem({ ...linux, nativeSsh: false, recorded: false })).toBeNull();
    expect(elevationProblem({ ...linux, nativeSsh: true, recorded: false })).toBe("elevate_needs_recording");
    expect(elevationProblem({ ...win, nativeRdp: false, recorded: false })).toBeNull();
    expect(elevationProblem({ ...win, nativeRdp: true, recorded: false })).toBe("elevate_needs_recording");
  });

  it("refuses accounts that are administrators already, or that cannot be named safely", () => {
    for (const u of ["root", "Deploy", "a.b", "a b", "a;b", "", "x".repeat(40)]) expect(elevationProblem({ ...linux, username: u })).toBe("elevate_root");
    for (const u of ["deploy", "_svc", "web-1"]) expect(elevationProblem({ ...linux, username: u })).toBeNull();
    for (const u of ["Administrator", ".\\administrator", "HOST\\Administrator"]) expect(elevationProblem({ ...win, username: u })).toBe("elevate_root");
    expect(elevationProblem({ ...win, windowsLocal: false })).toBe("elevate_windows_local");
  });
});

describe("administrator rights during sessions: which connectors carry them", () => {
  const cred = (o: object = {}) => ({ elevate: true, protocol: "SSH", reconcileUsername: "root", reconcileKind: "PASSWORD", reconcileSeals: { k1: "cv1:a", k2: "cv1:b" }, ...o });
  const m = (key: string | null, version: string | null) => ({ vaultPublicKey: key, version });

  it("is off, and changes nothing, when the resource does not ask for it", () => {
    expect(elevationPlan({ ...cred(), elevate: false }, [m("k1", "2.75.0")], "session")).toEqual({ on: false });
    expect(elevationPlan(null, [], "session")).toEqual({ on: false });
  });

  it("keeps the members new enough that hold their own seal", () => {
    const p = elevationPlan(cred(), [m("k1", "2.75.0"), m("k2", "2.72.0"), m("k3", "2.75.0")], "session");
    if (!p.on || !p.ok) throw new Error(JSON.stringify(p));
    expect(p.carriers.map((c) => c.vaultPublicKey)).toEqual(["k1"]);
    expect(p.sealOf(p.carriers[0])).toBe("cv1:a");
    expect(p.elevate).toEqual({ platform: "linux", username: "root", kind: "PASSWORD" });
  });

  it("says why when no connector can", () => {
    expect(elevationPlan(cred(), [m("k1", "2.74.0")], "session")).toEqual({ on: true, ok: false, error: "connector_outdated" });
    expect(elevationPlan(cred(), [m("k3", "2.75.0")], "session")).toEqual({ on: true, ok: false, error: "elevate_reenter" });
    expect(elevationPlan(cred({ reconcileUsername: null }), [m("k1", "2.75.0")], "session")).toEqual({ on: true, ok: false, error: "elevate_reenter" });
  });

  it("lets recorded native SSH use the older connectors that already do it, but not Windows", () => {
    expect(elevationPlan(cred(), [m("k1", ELEVATE_MIN_CONNECTOR)], "native-ssh")).toMatchObject({ on: true, ok: true });
    expect(elevationPlan(cred(), [m("k1", ELEVATE_MIN_CONNECTOR)], "session")).toMatchObject({ ok: false, error: "connector_outdated" });
    expect(elevationPlan(cred({ protocol: "RDP" }), [m("k1", ELEVATE_MIN_CONNECTOR)], "native-ssh")).toMatchObject({ ok: false, error: "connector_outdated" });
    expect(elevationPlan(cred({ protocol: "RDP" }), [m("k1", ELEVATE_SESSIONS_MIN_CONNECTOR)], "session")).toMatchObject({ ok: true, elevate: { platform: "windows" } });
  });
});
