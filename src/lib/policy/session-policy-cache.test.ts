import { describe, it, expect, vi } from "vitest";

const tenant = { id: "t_a" };
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => tenant.id }));
const findUnique = vi.fn(async ({ where }: { where: { tenantId: string } }) =>
  where.tenantId === "t_a"
    ? { idleTimeoutMinutes: 5, maxSessionHours: null, maxConcurrentPerUser: null, requireSecondFactor: true }
    : null,
);
vi.mock("@/lib/db", () => ({ db: { sessionPolicy: { findUnique: (a: { where: { tenantId: string } }) => findUnique(a) } } }));

const { getSessionPolicy } = await import("./session-policy");

describe("session policy cache", () => {
  it("never serves one workspace's policy to another", async () => {
    tenant.id = "t_a";
    expect((await getSessionPolicy()).requireSecondFactor).toBe(true);
    tenant.id = "t_b";
    expect(await getSessionPolicy()).toEqual({ idleTimeoutMinutes: null, maxSessionHours: null, maxConcurrentPerUser: null, requireSecondFactor: false });
    tenant.id = "t_a";
    expect((await getSessionPolicy()).idleTimeoutMinutes).toBe(5);
    expect(findUnique).toHaveBeenCalledTimes(2); // each workspace read once, then cached
  });
});
