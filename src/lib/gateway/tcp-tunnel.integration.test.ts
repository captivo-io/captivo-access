// TCP tunnel resources against a real Postgres with RLS: the portal's command
// is registered with the data plane and names the service; the jump host's
// check (POST /api/internal/gateway/native-ssh) answers `tunnel` with the
// service and the connectors that carry it, and refuses a revoked grant, a
// workspace that requires recording and a connector too old to relay TCP.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `tun-a-${suffix}`, slug: `tun-a-${suffix}` };
const conn = `tun-c-${suffix}`;
const site = `tuns-${suffix}`;
const vendor = `tun-v-${suffix}`;
const grant = `tun-g-${suffix}`;
const DP_SECRET = `tun-dp-${suffix}`;

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: vendor, email: "v@a.test", role: "VENDOR" }) }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("tcp tunnels", () => {
  let owner: PrismaClient;
  let portal: typeof import("@/app/api/portal/ssh/[siteId]/route");
  let internal: typeof import("@/app/api/internal/gateway/native-ssh/route");
  let fakeDataplane: Server;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let settings: typeof import("@/lib/settings/platform");
  // The settings are cached for 30 s; a fresh read stands in for the Policy page's save.
  const reloadSettings = () => withTenant(tA.id, () => settings.getPlatformSettingsFresh());
  const registered: Record<string, string>[] = [];

  const check = () => internal.POST(new Request("http://x/api/internal/gateway/native-ssh", {
    method: "POST", headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET }, body: JSON.stringify({ userId: vendor, siteId: site }),
  }) as unknown as NextRequest);
  const command = () => portal.POST(new Request(`http://${tA.slug}.example.test/api/portal/ssh/${site}`, { method: "POST" }), { params: Promise.resolve({ siteId: site }) });

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Tun A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version) VALUES($1,$2,'one',$1,'ONLINE','2.58.3')`, conn, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","tunnelHost","tunnelPort") VALUES($1,$2,$3,'Redis','TUNNEL','redis.corp',6379)`, site, tA.id, conn);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'v@a.test','Vendor','VENDOR','ACTIVE')`, vendor, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId",status,"endsAt") VALUES($1,$2,$3,$4,'ACTIVE', now() + interval '2 hours')`, grant, tA.id, vendor, site);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.VAULT_ENABLED = "true";
    process.env.ACCESS_DOMAIN = "example.test";
    process.env.RECORDING_ENABLED = "true";
    fakeDataplane = createServer((rq, res) => {
      if (rq.headers["x-dataplane-secret"] !== DP_SECRET) return void res.writeHead(403).end();
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (rq.url !== "/ssh-ticket") return void res.writeHead(404).end();
        registered.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, fingerprint: "SHA256:test" }));
      });
    });
    await new Promise<void>((r) => fakeDataplane.listen(0, "127.0.0.1", r));
    process.env.DATAPLANE_URL = `http://127.0.0.1:${(fakeDataplane.address() as AddressInfo).port}`;
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    portal = await import("@/app/api/portal/ssh/[siteId]/route");
    internal = await import("@/app/api/internal/gateway/native-ssh/route");
    ({ withTenant } = await import("@/lib/tenant/scope"));
    settings = await import("@/lib/settings/platform");
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    await new Promise((r) => fakeDataplane.close(r));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN", "RECORDING_ENABLED"]) delete process.env[k];
  });

  it("hands out a command for the service and registers its ticket", async () => {
    const res = await command();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ tunnel: true, recorded: false, targetHost: "redis.corp", targetPort: 6379, fingerprint: "SHA256:test" });
    expect(registered.at(-1)).toMatchObject({ code: j.code, tenantId: tA.id, siteId: site, userId: vendor });
  });

  it("tells the jump host it is a tunnel, and where to", async () => {
    const res = await check();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ tunnel: true, tenantId: tA.id, siteName: "Redis", targetHost: "redis.corp", targetPort: 6379, connectorId: conn });
    expect(j).not.toHaveProperty("record");
  });

  it("refuses with 403 while the grant is revoked", async () => {
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'REVOKED' WHERE id = $1`, grant);
    expect((await check()).status).toBe(403);
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'ACTIVE' WHERE id = $1`, grant);
  });

  it("closes while the workspace requires recording", async () => {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformSettings"("tenantId","recordingMode","updatedAt") VALUES($1,'required',now())`, tA.id);
    await reloadSettings();
    const res = await check();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("recording_required");
    expect((await command()).status).toBe(409);
    await owner.$executeRawUnsafe(`DELETE FROM "PlatformSettings" WHERE "tenantId" = $1`, tA.id);
    await reloadSettings();
  });

  it("refuses a connector too old to relay TCP", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.38.0' WHERE id = $1`, conn);
    const res = await check();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("connector_outdated");
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.58.3' WHERE id = $1`, conn);
    expect((await check()).status).toBe(200);
  });
});
