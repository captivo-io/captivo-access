import { beforeEach, describe, expect, it, vi } from "vitest";

const SEAL = (n: number) => "cv1:" + Buffer.alloc(60, n).toString("base64");

const cred = vi.fn();
const connectors = vi.fn();
vi.mock("@/lib/db", () => ({ db: { vaultCredential: { findUnique: (...a: unknown[]) => cred(...a) }, connector: { findMany: (...a: unknown[]) => connectors(...a) } } }));
vi.mock("@/lib/vault/store", async () => {
  const real = await vi.importActual<typeof import("@/lib/vault/store")>("@/lib/vault/store");
  return { ...real, holderKeys: vi.fn().mockResolvedValue({ keys: ["k-new-a", "k-new-b"], complete: true }) };
});

import { canRetarget, moveKeptSecret, RETARGET_MIN_CONNECTOR } from "./retarget";

const TO = { host: " 10.0.0.9 ", port: 2222, username: " bob " };
const stored = (over: Record<string, unknown> = {}) => ({ targetHost: "10.0.0.5", targetPort: 22, username: "alice", secret: SEAL(1), sealedTo: "k-old", extraSeals: null, secretSource: null, ...over });
const holder = { connectorId: "c-new" };

beforeEach(() => {
  cred.mockReset();
  connectors.mockReset();
});

describe("canRetarget", () => {
  it("takes an online connector on 2.79.0 or later, or a dev build", () => {
    expect(RETARGET_MIN_CONNECTOR).toBe("2.79.0");
    expect(canRetarget({ status: "ONLINE", version: "2.79.0" })).toBe(true);
    expect(canRetarget({ status: "ONLINE", version: "3.0.0" })).toBe(true);
    expect(canRetarget({ status: "ONLINE", version: "dev" })).toBe(true);
    expect(canRetarget({ status: "ONLINE", version: "2.78.2" })).toBe(false);
    expect(canRetarget({ status: "OFFLINE", version: "2.79.0" })).toBe(false);
    expect(canRetarget({ status: "ONLINE", version: null })).toBe(false);
  });
});

describe("moveKeptSecret", () => {
  it("asks the connector that holds the copy to re-seal it for the new target, to the new holders' keys", async () => {
    cred.mockResolvedValue(stored());
    connectors.mockResolvedValue([{ id: "c-old", status: "ONLINE", version: "2.79.0", vaultPublicKey: "k-old" }]);
    const call = vi.fn().mockResolvedValue({ seals: { "k-new-a": SEAL(2), "k-new-b": SEAL(3) } });
    const r = await moveKeptSecret("s1", holder, TO, call);
    expect(r).toMatchObject({ connectorId: "c-old", from: { host: "10.0.0.5", port: 22, username: "alice" }, to: { host: "10.0.0.9", port: 2222, username: "bob" } });
    if ("error" in r) throw new Error("unreachable");
    expect(r.columns.sealedTo).toBe("k-new-a");
    expect(r.columns.secret).toBe(SEAL(2));
    expect(r.columns.extraSeals).toEqual({ "k-new-b": SEAL(3) });
    expect(call).toHaveBeenCalledWith("c-old", {
      op: "retarget", method: "linux", host: "10.0.0.5", port: "22", username: "alice", current: SEAL(1), to: ["k-new-a", "k-new-b"],
      newHost: "10.0.0.9", newPort: "2222", newUsername: "bob",
    });
  });

  it("does not touch a credential that is a vault reference or a certificate sign-in", async () => {
    cred.mockResolvedValue(stored({ secretSource: "hashicorp" }));
    const call = vi.fn();
    expect(await moveKeptSecret("s1", holder, TO, call)).toMatchObject({ error: "vault_secret_required", status: 400 });
    expect(call).not.toHaveBeenCalled();
  });

  it("asks for the password again when there is nothing sealed to move", async () => {
    cred.mockResolvedValue(stored({ sealedTo: null }));
    expect(await moveKeptSecret("s1", holder, TO, vi.fn())).toMatchObject({ error: "vault_secret_required" });
    cred.mockResolvedValue(null);
    expect(await moveKeptSecret("s1", holder, TO, vi.fn())).toMatchObject({ error: "vault_secret_required" });
  });

  it("says why when no holding connector is online and new enough", async () => {
    cred.mockResolvedValue(stored());
    connectors.mockResolvedValue([{ id: "c-old", status: "ONLINE", version: "2.78.2", vaultPublicKey: "k-old" }, { id: "c-off", status: "OFFLINE", version: "2.79.0", vaultPublicKey: "k-old" }]);
    const call = vi.fn();
    const r = await moveKeptSecret("s1", holder, TO, call);
    expect(r).toMatchObject({ error: "retarget_unavailable", status: 409 });
    expect(call).not.toHaveBeenCalled();
  });

  it("fails closed when the connector errors or answers with fewer seals than keys", async () => {
    cred.mockResolvedValue(stored());
    connectors.mockResolvedValue([{ id: "c-old", status: "ONLINE", version: "2.79.0", vaultPublicKey: "k-old" }]);
    expect(await moveKeptSecret("s1", holder, TO, vi.fn().mockResolvedValue({ error: "the saved password does not open here" }))).toMatchObject({ error: "retarget_failed", status: 502, detail: "the saved password does not open here" });
    expect(await moveKeptSecret("s1", holder, TO, vi.fn().mockResolvedValue({ seals: { "k-new-a": SEAL(2) } }))).toMatchObject({ error: "retarget_failed", status: 502 });
    expect(await moveKeptSecret("s1", holder, TO, vi.fn().mockResolvedValue({ seals: { "k-new-a": "plain-text", "k-new-b": SEAL(3) } }))).toMatchObject({ error: "retarget_failed" });
  });
});
