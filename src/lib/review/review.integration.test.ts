// Access reviews against a real Postgres with RLS: a review lists only its own
// tenant's live grants with when each was last used, reviewers can't decide on
// their own access or revoke a directory grant, closing revokes what was
// decided (recording who and why) and what nobody answered (but never a
// reviewer's own), limits end dates, and the hourly job opens the next
// recurring one.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const sfx = crypto.randomUUID().slice(0, 8);
const tA = { id: `arv-a-${sfx}`, slug: `arv-a-${sfx}` };
const tB = { id: `arv-b-${sfx}`, slug: `arv-b-${sfx}` };
const u = { admin: `arv-adm-${sfx}`, op: `arv-op-${sfx}`, v1: `arv-v1-${sfx}`, v2: `arv-v2-${sfx}`, staff: `arv-st-${sfx}`, bVendor: `arv-bv-${sfx}` };
const site = `arv-s-${sfx}`, siteB = `arv-sb-${sfx}`;

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));

function toAppUrl(owner: string): string {
  const x = new URL(owner);
  x.username = "app";
  x.password = "rls_test_pw";
  return x.toString();
}

describe.skipIf(!OWNER_URL)("access reviews", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let store: typeof import("@/lib/review/store");
  let reviewId = "";
  const item = async (userId: string) => (await owner.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "AccessReviewItem" WHERE "reviewId" = $1 AND "userId" = $2`, reviewId, userId))[0].id;
  const grant = async (userId: string) => (await owner.$queryRawUnsafe<{ status: string; revokedById: string | null; revokeReason: string | null; endsAt: Date | null }[]>(`SELECT status, "revokedById", "revokeReason", "endsAt" FROM "AccessGrant" WHERE "userId" = $1`, userId))[0];
  const actor = (id: string) => ({ id, email: `${id}@a.test` });

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Rev','ACTIVE')`, t.id, t.slug);
    const users: [string, string, string][] = [[u.admin, "ADMIN", tA.id], [u.op, "OPERATOR", tA.id], [u.v1, "VENDOR", tA.id], [u.v2, "VENDOR", tA.id], [u.staff, "STAFF", tA.id], [u.bVendor, "VENDOR", tB.id]];
    for (const [id, role, t] of users) await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,$3,$1,$4,'ACTIVE')`, id, t, `${id}@a.test`, role);
    for (const [c, t] of [[`arv-c-${sfx}`, tA.id], [`arv-cb-${sfx}`, tB.id]]) await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status) VALUES($1,$2,'c',$1,'ONLINE')`, c, t);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode") VALUES($1,$2,$3,'CRM','TRANSPARENT'),($4,$5,$6,'Other','TRANSPARENT')`, site, tA.id, `arv-c-${sfx}`, siteB, tB.id, `arv-cb-${sfx}`);
    const grants: [string, string, boolean][] = [[u.v1, site, false], [u.v2, site, false], [u.op, site, false], [u.staff, site, true], [u.admin, site, false], [u.bVendor, siteB, false]];
    for (const [uid, s, dir] of grants) {
      const t = s === siteB ? tB.id : tA.id;
      await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId",status,"createdById","directoryManaged") VALUES($1,$2,$3,$4,'ACTIVE',$5,$6)`, `g-${uid}`, t, uid, s, dir ? null : u.admin, dir);
    }
    await owner.$executeRawUnsafe(`INSERT INTO "AuditEvent"(id,"tenantId",seq,timestamp,"userId","siteId",host,method,path,status,decision,reason) VALUES($1,$2,1,now() - interval '3 days',$3,$4,'h','GET','/',200,'ALLOW','')`, `ae-${sfx}`, tA.id, u.v1, site);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.ACCESS_DOMAIN = "example.test";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    store = await import("@/lib/review/store");
  });

  afterAll(async () => {
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, t.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "ACCESS_DOMAIN"]) delete process.env[k];
  });

  it("lists only this tenant's live grants, with when each was last used", async () => {
    reviewId = await withTenant(tA.id, () => store.createReview({ name: "Q1", siteIds: [], dueDays: 14, onNoAnswer: "revoke", recurrence: "quarterly", opensAt: null }, actor(u.admin)));
    const rows = await owner.$queryRawUnsafe<{ userId: string; tenantId: string; lastUsedAt: Date | null }[]>(`SELECT "userId","tenantId","lastUsedAt" FROM "AccessReviewItem" WHERE "reviewId" = $1`, reviewId);
    expect(rows.map((r) => r.userId).sort()).toEqual([u.admin, u.op, u.staff, u.v1, u.v2].sort());
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([tA.id]));
    expect(rows.find((r) => r.userId === u.v1)!.lastUsedAt).not.toBeNull();
    expect(rows.find((r) => r.userId === u.v2)!.lastUsedAt).toBeNull();
    const seenFromB = await withTenant(tB.id, async () => (await import("@/lib/db")).db.accessReview.count());
    expect(seenFromB).toBe(0);
  });

  it("refuses a reviewer's own access and revoking a directory grant", async () => {
    const r1 = await withTenant(tA.id, async () => store.decide(reviewId, [await item(u.op)], "keep", null, actor(u.op)));
    expect(r1.skipped[0].why).toBe("own_access");
    const r2 = await withTenant(tA.id, async () => store.decide(reviewId, [await item(u.staff)], "revoke", null, actor(u.op)));
    expect(r2.skipped[0].why).toBe("directory_managed");
  });

  it("applies decisions on close, and revokes silence except a reviewer's own and directory grants", async () => {
    const limit = new Date(Date.now() + 10 * 86_400_000);
    await withTenant(tA.id, async () => {
      await store.decide(reviewId, [await item(u.v1)], "limit", limit, actor(u.op));
      await store.decide(reviewId, [await item(u.op)], "revoke", null, actor(u.admin));
    });
    const summary = await withTenant(tA.id, () => store.closeReview(reviewId, actor(u.admin)));
    expect(summary).toMatchObject({ total: 5, limited: 1, revoked: 1, auto_revoked: 1, unanswered: 2 });
    expect((await grant(u.v1)).endsAt!.getTime()).toBe(limit.getTime());
    expect(await grant(u.op)).toMatchObject({ status: "REVOKED", revokedById: u.admin, revokeReason: `review:${reviewId}` });
    expect(await grant(u.v2)).toMatchObject({ status: "REVOKED", revokedById: null });
    expect((await grant(u.admin)).status).toBe("ACTIVE");
    expect((await grant(u.staff)).status).toBe("ACTIVE");
    expect((await grant(u.bVendor)).status).toBe("ACTIVE");
  });

  it("schedules the next recurring review and the hourly pass opens it when due", async () => {
    const next = await owner.$queryRawUnsafe<{ id: string; status: string }[]>(`SELECT id, status FROM "AccessReview" WHERE "tenantId" = $1 AND status = 'scheduled'`, tA.id);
    expect(next).toHaveLength(1);
    await owner.$executeRawUnsafe(`UPDATE "AccessReview" SET "opensAt" = now() - interval '1 minute' WHERE id = $1`, next[0].id);
    const pass = await withTenant(tA.id, () => store.runReviewPass());
    expect(pass.opened).toBe(1);
    expect(pass.mail[0]).toMatchObject({ kind: "open", pending: 3 });
    expect(pass.mail[0].to.sort()).toEqual([`${u.admin}@a.test`, `${u.op}@a.test`].sort());
  });
});
