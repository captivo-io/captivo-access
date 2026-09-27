import { describe, expect, it, vi, beforeEach } from "vitest";

const multiTenant = vi.fn(() => false);
const listIds = vi.fn(async () => [] as string[]);
const scopes: string[] = [];

vi.mock("@/lib/tenant/enabled", () => ({ multiTenantEnabled: () => multiTenant() }));
vi.mock("@/lib/tenant/internal", () => ({ listActiveTenantIds: () => listIds() }));
vi.mock("@/lib/tenant/scope", () => ({
  // Stands in for the real transaction-opening scope, recording that one was opened.
  withTenant: async (id: string, fn: () => Promise<unknown>) => {
    scopes.push(id);
    return fn();
  },
}));

const { forEachTenantId, inTenant, forEachTenant } = await import("./for-each-tenant");

beforeEach(() => {
  scopes.length = 0;
  multiTenant.mockReturnValue(false);
  listIds.mockResolvedValue([]);
});

describe("forEachTenantId", () => {
  it("self-host: runs once, hands null, and opens NO scope", async () => {
    const seen: (string | null)[] = [];
    const out = await forEachTenantId(async (id) => {
      seen.push(id);
      return "done";
    });
    expect(seen).toEqual([null]);
    expect(out).toEqual(["done"]);
    expect(scopes, "self-host must not open a tenant transaction").toEqual([]);
  });

  it("cloud: visits every active tenant and STILL opens no scope of its own", async () => {
    multiTenant.mockReturnValue(true);
    listIds.mockResolvedValue(["t1", "t2"]);
    const seen: (string | null)[] = [];
    await forEachTenantId(async (id) => void seen.push(id));
    expect(seen).toEqual(["t1", "t2"]);
    // The whole point: the slow phase runs outside any transaction. If this helper
    // opened one, a job's probes would sit inside it again.
    expect(scopes, "forEachTenantId must leave scoping to the caller").toEqual([]);
  });

  it("forEachTenant still scopes, so DB-only jobs are unchanged", async () => {
    multiTenant.mockReturnValue(true);
    listIds.mockResolvedValue(["t1", "t2"]);
    await forEachTenant(async () => undefined);
    expect(scopes).toEqual(["t1", "t2"]);
  });
});

describe("inTenant", () => {
  it("opens one scope per call in cloud mode", async () => {
    await inTenant("t9", async () => undefined);
    expect(scopes).toEqual(["t9"]);
  });

  it("runs unscoped when there is no tenant (self-host)", async () => {
    await inTenant(null, async () => undefined);
    expect(scopes).toEqual([]);
  });

  it("returns the callback's value through both paths", async () => {
    expect(await inTenant("t1", async () => 41 + 1)).toBe(42);
    expect(await inTenant(null, async () => 41 + 1)).toBe(42);
  });
});
