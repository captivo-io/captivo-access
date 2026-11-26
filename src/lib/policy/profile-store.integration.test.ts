// Policy profiles against a real Postgres with RLS: a profile is written through to the
// resources that follow it (per kind of resource), rewritten when it changes, and a
// profile that resources follow cannot be deleted. A bad profile or list id is refused
// before anything is saved.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql applied with
// app_password=rls_test_pw); SKIPPED otherwise. Run it in its own vitest process.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `prof-a-${suffix}`, slug: `prof-a-${suffix}` };

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("policy profiles", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let store: typeof import("@/lib/policy/profile-store");
  let db: typeof import("@/lib/db").db;
  const conn = `conn-${tA.id}`;

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Profile test','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash") VALUES($1,$2,'c',$3)`, conn, tA.id, `h-${tA.id}`);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ACCESS_DOMAIN = "example.test";
    process.env.MANAGER_PUBLIC_URL = "https://manager.example.test";
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    ({ db } = await import("@/lib/db"));
    store = await import("@/lib/policy/profile-store");
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ACCESS_DOMAIN", "MANAGER_PUBLIC_URL", "ENCRYPTION_KEY"]) delete process.env[k];
  });

  const mk = (name: string, accessMode: "GATEWAY" | "TUNNEL" | "ISOLATED") => db.site.create({ data: { name, accessMode, connectorId: conn }, select: { id: true } });

  it("writes a profile onto the resources that follow it, per kind, and rewrites them when it changes", async () => {
    await withTenant(tA.id, async () => {
      const list = await db.commandList.create({ data: { name: "L1", mode: "deny", entries: ["rm"] } });
      const profile = await db.policyProfile.create({ data: { name: "Vendor", recordSessions: true, keystrokeLogging: true, clipboardMode: "no_paste", requireModerator: true, passwordCheckout: true, commandListId: list.id } });
      const gw = await mk("gw", "GATEWAY");
      const tn = await mk("tn", "TUNNEL");
      const iso = await mk("iso", "ISOLATED");
      for (const s of [gw, tn, iso]) expect(await store.applyPolicyChoices(s.id, { policyProfileId: profile.id })).toBeNull();

      const g = await db.site.findUnique({ where: { id: gw.id } });
      expect(g).toMatchObject({ recordSessions: true, keystrokeLogging: true, clipboardMode: "no_paste", requireModerator: true, passwordCheckout: false, commandListId: list.id, policyProfileId: profile.id });
      expect(await db.site.findUnique({ where: { id: iso.id } })).toMatchObject({ recordSessions: true, clipboardMode: "no_paste", requireModerator: false });
      expect(await db.site.findUnique({ where: { id: tn.id } })).toMatchObject({ recordSessions: false, clipboardMode: null, commandListId: null });

      await db.policyProfile.update({ where: { id: profile.id }, data: { clipboardMode: "none", requireModerator: false } });
      expect(await store.reapplyProfile(profile.id)).toBe(3);
      expect(await db.site.findUnique({ where: { id: gw.id } })).toMatchObject({ clipboardMode: "none", requireModerator: false, passwordCheckout: true });
    });
  });

  it("refuses a profile or a list that does not exist, before anything is saved", async () => {
    await withTenant(tA.id, async () => {
      expect(await store.checkPolicyChoices({ policyProfileId: "nope" })).toBe("unknown_profile");
      expect(await store.checkPolicyChoices({ commandListId: "nope" })).toBe("unknown_command_list");
      expect(await store.checkPolicyChoices({ policyProfileId: null, commandListId: "" })).toBeNull();
      const s = await mk("x", "GATEWAY");
      expect(await store.applyPolicyChoices(s.id, { policyProfileId: "nope" })).toBe("unknown_profile");
    });
  });

  it("a command list can be picked on its own and detached; a followed profile cannot be deleted", async () => {
    const ids = await withTenant(tA.id, async () => {
      const list = await db.commandList.create({ data: { name: "Solo", mode: "allow", entries: ["ls"] } });
      const profile = await db.policyProfile.create({ data: { name: "Held" } });
      const s = await mk("solo", "GATEWAY");
      expect(await store.applyPolicyChoices(s.id, { commandListId: list.id })).toBeNull();
      expect((await db.site.findUnique({ where: { id: s.id } }))?.commandListId).toBe(list.id);
      expect(await store.applyPolicyChoices(s.id, { commandListId: null })).toBeNull();
      expect((await db.site.findUnique({ where: { id: s.id } }))?.commandListId).toBeNull();
      await store.applyPolicyChoices(s.id, { policyProfileId: profile.id });
      return { site: s.id, profile: profile.id };
    });
    // The database itself refuses to drop a profile a resource follows (ON DELETE RESTRICT).
    await expect(owner.$executeRawUnsafe(`DELETE FROM "PolicyProfile" WHERE id = $1`, ids.profile)).rejects.toThrow();
    await withTenant(tA.id, async () => {
      // Detached, the resource keeps what it had and the profile can go.
      expect(await store.applyPolicyChoices(ids.site, { policyProfileId: null })).toBeNull();
      await db.policyProfile.delete({ where: { id: ids.profile } });
      expect(await db.policyProfile.findUnique({ where: { id: ids.profile } })).toBeNull();
    });
  });

  it("is isolated per tenant: another tenant cannot see a workspace's profiles or lists", async () => {
    const other = `prof-b-${suffix}`;
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$1,'Other','ACTIVE')`, other);
    try {
      await withTenant(tA.id, () => db.policyProfile.create({ data: { name: "Mine" } }));
      const seen = await withTenant(other, async () => ({ p: await db.policyProfile.count(), l: await db.commandList.count() }));
      expect(seen).toEqual({ p: 0, l: 0 });
    } finally {
      await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, other);
    }
  });
});
