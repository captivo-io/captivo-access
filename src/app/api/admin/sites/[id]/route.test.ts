import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Editing a remote desktop / SSH resource without typing the password again
// must keep the stored credential. It used to go through an upsert whose
// create branch lacked the required `secret`, which Prisma rejects even when
// the row exists, so every such save failed.
const tx = {
  site: { update: vi.fn() },
  vaultCredential: { update: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
};
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: "a1", email: "a@x", role: "ADMIN" }) }));
vi.mock("@/lib/db", () => ({
  db: {
    connector: { findUnique: async () => ({ id: "c1" }) },
    site: { findUnique: async () => ({ id: "s1", hostname: null }) },
    vaultCredential: { count: vi.fn() },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));
vi.mock("@/lib/recording/enabled", () => ({ recordingEnabled: () => true }));
vi.mock("@/lib/gateway/native", () => ({ nativeGatewayEnabled: () => true }));
vi.mock("@/lib/isolation/enabled", () => ({ isolationEnabled: () => true }));
vi.mock("@/lib/tenant/envelope", () => ({ capabilityAllowed: async () => true }));
vi.mock("@/lib/site/host-suffix", () => ({ siteHostSuffix: async () => null }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/vault/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/vault/store")>("@/lib/vault/store");
  return { ...actual, keptSecretStillOpens: async () => true, sealLegacyCredentials: vi.fn(), storedSecretFor: async () => ({ secret: "cv1:new", sealedTo: "pk" }) };
});

import { PATCH } from "./route";
import { db } from "@/lib/db";

const body = { connectorId: "c1", name: "WP-SSH", accessMode: "GATEWAY", protocol: "SSH", targetHost: "192.168.10.156", targetPort: 22, username: "serdar", recordSessions: true, keystrokeLogging: true };
const call = (b: Record<string, unknown>) =>
  PATCH(new NextRequest("http://x/api/admin/sites/s1", { method: "PATCH", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "s1" }) });

describe("editing a remote resource's credential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the stored password when none is typed", async () => {
    vi.mocked(db.vaultCredential.count).mockResolvedValue(1);
    const res = await call(body);
    expect(res.status).toBe(200);
    expect(tx.vaultCredential.upsert).not.toHaveBeenCalled();
    expect(tx.vaultCredential.create).not.toHaveBeenCalled();
    const data = tx.vaultCredential.update.mock.calls[0][0].data;
    expect(data.username).toBe("serdar");
    expect(data).not.toHaveProperty("secret");
    expect(tx.site.update.mock.calls[0][0].data.keystrokeLogging).toBe(true);
  });

  it("creates the credential, with its secret, when there was none", async () => {
    vi.mocked(db.vaultCredential.count).mockResolvedValue(0);
    const res = await call({ ...body, secret: "pw" });
    expect(res.status).toBe(200);
    expect(tx.vaultCredential.create.mock.calls[0][0].data).toMatchObject({ siteId: "s1", secret: "cv1:new", secretKind: "PASSWORD" });
  });
});
