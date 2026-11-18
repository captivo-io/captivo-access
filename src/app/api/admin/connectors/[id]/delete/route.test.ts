import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const tx = { site: { deleteMany: vi.fn() }, connector: { delete: vi.fn() } };
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: "a1", email: "a@x", role: "ADMIN" }) }));
vi.mock("@/lib/audit/admin", () => ({ recordAdminAction: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    connector: { findUnique: vi.fn() },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";

const call = (b?: unknown) =>
  POST(new NextRequest("http://x/api/admin/connectors/c1/delete", { method: "POST", ...(b ? { body: JSON.stringify(b), headers: { "content-type": "application/json" } } : {}) }), { params: Promise.resolve({ id: "c1" }) });
const revoked = (sites: number) => ({ id: "c1", name: "Home Lab", status: "REVOKED", sites: Array.from({ length: sites }, (_, i) => ({ id: `s${i}` })) });

describe("deleting a connector", () => {
  beforeEach(() => vi.clearAllMocks());

  it("still refuses one with resources when not asked to take them", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue(revoked(2) as never);
    const res = await call();
    expect(res.status).toBe(409);
    expect(tx.connector.delete).not.toHaveBeenCalled();
  });

  it("takes its resources along when the name is typed back", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue(revoked(2) as never);
    const res = await call({ withResources: true, confirmName: "Home Lab" });
    expect(await res.json()).toEqual({ ok: true, deletedResources: 2 });
    expect(tx.site.deleteMany.mock.calls[0][0]).toEqual({ where: { id: { in: ["s0", "s1"] } } });
    expect(tx.connector.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(vi.mocked(recordAdminAction).mock.calls.map((c) => c[0].action)).toEqual(["resource.delete", "resource.delete", "connector.delete"]);
  });

  it("refuses a wrong name", async () => {
    vi.mocked(db.connector.findUnique).mockResolvedValue(revoked(2) as never);
    const res = await call({ withResources: true, confirmName: "Home" });
    expect(res.status).toBe(400);
    expect(tx.site.deleteMany).not.toHaveBeenCalled();
  });
});
