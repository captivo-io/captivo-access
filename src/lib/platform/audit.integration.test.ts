// A platform action on a tenant is written to the platform's admin chain inside
// the request's own transaction, then mirrored into the tenant's chain from a
// nested withTenant (its own transaction). With one global chain lock the
// mirror waited on the outer append and both expired, rolling the action back.
// Runs the real withTenant + db proxy as the `app` role; SKIPPED without
// TEST_DATABASE_URL. Own vitest process (mutates env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_PW = "rls_test_pw";
const TENANT = { id: "tenPA", slug: "wa-pa" };
const ACTION = "platform.tenant.force_logout";

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = APP_PW;
  return u.toString();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!OWNER_URL)("recordPlatformAction inside the platform scope", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let recordPlatformAction: (input: any) => Promise<void>;

  const cleanup = async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "AdminAuditEvent" WHERE action=$1`, ACTION);
    await owner.$executeRawUnsafe(`DELETE FROM "AuditChainState" WHERE "tenantId" IN ('platform',$1)`, TENANT.id);
  };

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name) VALUES('platform','platform','Platform'),($1,$2,'PA') ON CONFLICT (id) DO NOTHING`, TENANT.id, TENANT.slug);
    await cleanup();
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    ({ recordPlatformAction } = await import("@/lib/platform/audit"));
  });

  afterAll(async () => {
    await cleanup();
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id=$1`, TENANT.id);
    await owner.$disconnect();
    delete process.env.MULTI_TENANT;
    delete process.env.APP_DATABASE_URL;
  });

  it("lands in both chains and the outer transaction commits", async () => {
    const started = Date.now();
    await withTenant("platform", () =>
      recordPlatformAction({ actor: { id: "op", email: "op@example.com" }, action: ACTION, tenant: TENANT, summary: "Ended all 0 sessions" }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    const rows = await owner.$queryRawUnsafe<{ tenantId: string; summary: string }[]>(
      `SELECT "tenantId", summary FROM "AdminAuditEvent" WHERE action=$1 ORDER BY "tenantId"`, ACTION,
    );
    expect(rows).toEqual([
      { tenantId: "platform", summary: "Ended all 0 sessions" },
      { tenantId: TENANT.id, summary: "[Captivo platform] Ended all 0 sessions" },
    ]);
  }, 20_000);
});
