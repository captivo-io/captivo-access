// Moderated sessions against a real Postgres with RLS: a resource that needs a
// moderator starts a session only with an admission. The user asks (POST
// /api/gateway/[siteId]/moderation), a moderator admits it (POST
// /api/admin/moderation/[id]), and the gateway descriptor uses the admission
// once, naming the moderator for the data plane. Nobody admits their own
// session, operators only while Policy lets them, and native RDP is refused.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `mod-a-${suffix}`, slug: `mod-a-${suffix}` };
const tB = { id: `mod-b-${suffix}`, slug: `mod-b-${suffix}` };
const conn = `mod-c-${suffix}`;
const site = `mods-${suffix}`;
const vendor = `mod-v-${suffix}`;
const admin = `mod-ad-${suffix}`;
const operator = `mod-op-${suffix}`;
const DP_SECRET = `mod-dp-${suffix}`;
const target = { host: "10.0.0.5", port: 3389, username: "Administrator" };

const people: Record<string, { id: string; email: string; name: string; role: string }> = {
  [vendor]: { id: vendor, email: "v@a.test", name: "Vendor Vic", role: "VENDOR" },
  [admin]: { id: admin, email: "ad@a.test", name: "Admin Ada", role: "ADMIN" },
  [operator]: { id: operator, email: "op@a.test", name: "Operator Oz", role: "OPERATOR" },
};
let me = vendor;
vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => people[me] }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("moderated sessions", () => {
  let owner: PrismaClient;
  let userRoute: typeof import("@/app/api/gateway/[siteId]/moderation/route");
  let decideRoute: typeof import("@/app/api/admin/moderation/[id]/route");
  let descriptor: typeof import("@/app/api/internal/gateway/descriptor/route");
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let settings: typeof import("@/lib/settings/platform");
  let requests: typeof import("@/lib/moderation/requests");
  let rdp: typeof import("@/lib/gateway/native-rdp-target");
  const reloadSettings = () => withTenant(tA.id, () => settings.getPlatformSettingsFresh());

  const ask = async () => {
    me = vendor;
    const res = await userRoute.POST(new Request(`http://${tA.slug}.example.test/api/gateway/${site}/moderation`, { method: "POST", body: JSON.stringify({ kind: "browser" }) }), { params: Promise.resolve({ siteId: site }) });
    return { status: res.status, body: (await res.json()) as { id: string; status: string } };
  };
  const state = async (id: string) => {
    me = vendor;
    const res = await userRoute.GET(new Request(`http://${tA.slug}.example.test/api/gateway/${site}/moderation?id=${id}`));
    return ((await res.json()) as { status: string }).status;
  };
  const decide = async (who: string, id: string, action: "admit" | "decline") => {
    me = who;
    const res = await decideRoute.POST(new Request(`http://${tA.slug}.example.test/api/admin/moderation/${id}`, { method: "POST", body: JSON.stringify({ action }) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  const describeSession = async () => {
    const res = await descriptor.POST(new Request("http://x/api/internal/gateway/descriptor", {
      method: "POST", headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET }, body: JSON.stringify({ userId: vendor, siteId: site }),
    }) as unknown as NextRequest);
    return { status: res.status, body: (await res.json()) as { error?: string; moderation?: { id: string; moderatorId: string } } };
  };

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    const subtle = globalThis.crypto.subtle;
    const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const pub = Buffer.from(new Uint8Array(await subtle.exportKey("raw", kp.publicKey))).toString("base64");
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Mod','ACTIVE')`, t.id, t.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.58.3',$3)`, conn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions","nativeRdp","requireModerator") VALUES($1,$2,$3,'Core DC','GATEWAY',true,true,true)`, site, tA.id, conn);
    for (const p of Object.values(people)) {
      await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,$3,$4,$5::"Role",'ACTIVE')`, p.id, tA.id, p.email, p.name, p.role);
    }
    await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId",status,"endsAt") VALUES($1,$2,$3,$4,'ACTIVE', now() + interval '2 hours')`, `mod-g-${suffix}`, tA.id, vendor, site);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.VAULT_ENABLED = "true";
    process.env.GATEWAY_ENABLED = "true";
    process.env.ACCESS_DOMAIN = "example.test";
    process.env.RECORDING_ENABLED = "true";
    // No data plane: the console's session lookups find nothing, which these checks don't need.
    process.env.DATAPLANE_URL = "http://127.0.0.1:9";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    const seal = await import("@/lib/vault/seal");
    const sealed = await seal.sealSecret(pub, "dc-password", target);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","updatedAt") VALUES($1,$2,$3,'RDP',$4,$5,$6,$7,$8,now())`,
      `mod-vc-${suffix}`, tA.id, site, target.host, target.port, target.username, sealed, pub);
    userRoute = await import("@/app/api/gateway/[siteId]/moderation/route");
    decideRoute = await import("@/app/api/admin/moderation/[id]/route");
    descriptor = await import("@/app/api/internal/gateway/descriptor/route");
    ({ withTenant } = await import("@/lib/tenant/scope"));
    settings = await import("@/lib/settings/platform");
    requests = await import("@/lib/moderation/requests");
    rdp = await import("@/lib/gateway/native-rdp-target");
  });

  afterAll(async () => {
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, t.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "GATEWAY_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN", "RECORDING_ENABLED"]) delete process.env[k];
  });

  let first = "";

  it("refuses the session until a moderator admits it", async () => {
    const a = await ask();
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("waiting");
    first = a.body.id;
    expect((await ask()).body.id).toBe(first); // asking again waits on the same request
    const d = await describeSession();
    expect(d.status).toBe(409);
    expect(d.body.error).toBe("moderator_required");
  });

  it("lists it for moderators, in this workspace only", async () => {
    const mine = await withTenant(tA.id, () => requests.waitingRequests());
    expect(mine.map((r) => r.id)).toContain(first);
    expect(mine.find((r) => r.id === first)).toMatchObject({ userName: "Vendor Vic", siteName: "Core DC", kind: "browser" });
    expect(await withTenant(tB.id, () => requests.waitingRequests())).toEqual([]);
  });

  it("lets nobody admit their own session, and operators only while Policy allows", async () => {
    expect((await decide(vendor, first, "admit")).body.error).toBe("not_moderator");
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformSettings"("tenantId","moderatorRoles","updatedAt") VALUES($1,'admins',now())`, tA.id);
    await reloadSettings();
    expect((await decide(operator, first, "admit")).status).toBe(403);
    await owner.$executeRawUnsafe(`DELETE FROM "PlatformSettings" WHERE "tenantId" = $1`, tA.id);
    await reloadSettings();
    expect(await state(first)).toBe("waiting");
  });

  it("starts one session once admitted, naming the moderator", async () => {
    expect((await decide(admin, first, "admit")).status).toBe(200);
    expect((await decide(operator, first, "admit")).body.error).toBe("not_waiting");
    expect(await state(first)).toBe("admitted");
    const d = await describeSession();
    expect(d.status).toBe(200);
    expect(d.body.moderation).toEqual({ id: first, moderatorId: admin });
    expect(await state(first)).toBe("started");
    expect((await describeSession()).status).toBe(409); // the admission starts one session
    const audit = await owner.$queryRawUnsafe<{ action: string }[]>(`SELECT action FROM "AdminAuditEvent" WHERE "tenantId" = $1 AND action = 'session.moderate'`, tA.id);
    expect(audit).toHaveLength(1);
  });

  it("lets an operator decline the next one", async () => {
    const a = await ask();
    expect(a.body.id).not.toBe(first);
    expect((await decide(operator, a.body.id, "decline")).status).toBe(200);
    expect(await state(a.body.id)).toBe("declined");
    expect((await describeSession()).status).toBe(409);
  });

  it("tells the user at once when nobody else may moderate", async () => {
    await owner.$executeRawUnsafe(`UPDATE "User" SET status = 'DISABLED' WHERE id = ANY($1)`, [admin, operator]);
    const a = await ask();
    expect(a.status).toBe(409);
    expect((a.body as { error?: string }).error).toBe("no_moderators");
    // A vendor who may not moderate isn't counted; the one admin is, for anyone but themselves.
    await owner.$executeRawUnsafe(`UPDATE "User" SET status = 'ACTIVE' WHERE id = $1`, admin);
    expect(await withTenant(tA.id, () => requests.moderatorCount(vendor))).toBe(1);
    expect(await withTenant(tA.id, () => requests.moderatorCount(admin))).toBe(0);
    await owner.$executeRawUnsafe(`UPDATE "User" SET status = 'ACTIVE' WHERE id = $1`, operator);
  });

  it("keeps the user's own Remote Desktop app out", async () => {
    const t = await withTenant(tA.id, () => rdp.nativeRdpTarget(vendor, site, new Date()));
    expect(t).toMatchObject({ ok: false, status: 409, error: "moderator_browser_only" });
  });
});
