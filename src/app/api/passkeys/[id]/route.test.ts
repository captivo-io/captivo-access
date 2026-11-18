import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const updateMany = vi.fn();
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/db", () => ({ db: { passkey: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));

import { PATCH } from "./route";
import { getCurrentUser } from "@/lib/current-user";

const call = (body: unknown, id = "pk1") =>
  PATCH(new NextRequest(`http://x/api/passkeys/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) });

describe("rename a passkey", () => {
  beforeEach(() => { updateMany.mockReset(); updateMany.mockResolvedValue({ count: 1 }); });

  it("renames only the signed-in person's own passkey, trimmed", async () => {
    const res = await call({ label: "  MacBook Pro " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, label: "MacBook Pro" });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "pk1", userId: "u1" }, data: { label: "MacBook Pro" } });
  });

  it("refuses an empty or over-long name without writing", async () => {
    expect((await call({ label: " " })).status).toBe(400);
    expect((await call({ label: "x".repeat(41) })).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("someone else's passkey is not found", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect((await call({ label: "Mine now" })).status).toBe(404);
  });

  it("needs a session", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null);
    expect((await call({ label: "x" })).status).toBe(401);
  });
});
