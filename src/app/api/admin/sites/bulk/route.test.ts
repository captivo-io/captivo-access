import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const role = { value: "ADMIN" };
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: "a1", email: "a@x", role: role.value }) }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/vault/store", () => ({ sealLegacyCredentials: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    connector: { findUnique: vi.fn() },
  },
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { sealLegacyCredentials } from "@/lib/vault/store";

const sites = [
  { id: "web", name: "Wiki", accessMode: "TRANSPARENT", connectorId: "c1", vaultCredential: null },
  { id: "rdp", name: "DC", accessMode: "GATEWAY", connectorId: "c1", vaultCredential: { sealedTo: "pk1" } },
  { id: "old", name: "Old SSH", accessMode: "GATEWAY", connectorId: "c1", vaultCredential: { sealedTo: null } },
];
const call = (b: unknown) => POST(new NextRequest("http://x/api/admin/sites/bulk", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }));

describe("bulk resource actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role.value = "ADMIN";
    vi.mocked(db.site.findMany).mockResolvedValue(sites as never);
  });

  it("deletes every found resource in one go and audits each", async () => {
    const res = await call({ action: "delete", ids: ["web", "rdp", "old"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 3 });
    expect(vi.mocked(db.site.deleteMany).mock.calls[0][0]).toEqual({ where: { id: { in: ["web", "rdp", "old"] } } });
    expect(vi.mocked(recordAdminAction).mock.calls.map((c) => c[0].action)).toEqual(["resource.delete", "resource.delete", "resource.delete"]);
  });

  it("moves what can move and leaves a sealed remote desktop where it is", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue({ id: "c2", name: "New", status: "ONLINE" } as never);
    const res = await call({ action: "move", ids: ["web", "rdp", "old"], connectorId: "c2" });
    expect(await res.json()).toEqual({ ok: true, moved: 2, sealed: 1, already: 0 });
    expect(vi.mocked(db.site.updateMany).mock.calls[0][0]).toEqual({ where: { id: { in: ["web", "old"] } }, data: { connectorId: "c2" } });
    expect(vi.mocked(sealLegacyCredentials)).toHaveBeenCalledWith({ siteId: "old" });
    expect(vi.mocked(recordAdminAction)).toHaveBeenCalledTimes(2);
  });

  it("refuses a revoked target", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue({ id: "c3", name: "Gone", status: "REVOKED" } as never);
    const res = await call({ action: "move", ids: ["web"], connectorId: "c3" });
    expect(res.status).toBe(400);
    expect(db.site.updateMany).not.toHaveBeenCalled();
  });

  it("is for configuring roles only", async () => {
    role.value = "AUDITOR";
    const res = await call({ action: "delete", ids: ["web"] });
    expect(res.status).toBe(403);
    expect(db.site.deleteMany).not.toHaveBeenCalled();
  });
});
