// Database access against a real Postgres with RLS: the portal hands out a
// ticket tied to the browser session, stored only hashed; the proxy's check
// (POST /api/internal/gateway/database) resolves its tenant from the ticket
// and answers with the target and a seal only the resource's connector opens;
// an unknown ticket, a revoked grant, a signed-out session and a too-old
// connector are each refused with the status the proxy acts on.
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
import { createHash } from "node:crypto";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `dba-a-${suffix}`, slug: `dba-a-${suffix}` };
const conn = `dba-c-${suffix}`;
const site = `dbas-${suffix}`;
const vendor = `dba-v-${suffix}`;
const session = `dba-sess-${suffix}`;
const grant = `dba-g-${suffix}`;
const TOKEN = `dba-token-${suffix}-0123456789`;
const DP_SECRET = `dba-dp-${suffix}`;
const subtle = globalThis.crypto.subtle;
const target = { host: "10.0.0.9", port: 5432, username: "app_ro" };

vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers,
  cookies: async () => ({ get: (n: string) => (n === "ca_session" ? { value: TOKEN } : undefined) }),
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: vendor, email: "v@a.test", role: "VENDOR" }) }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("database access", () => {
  let owner: PrismaClient;
  let seal: typeof import("@/lib/vault/seal");
  let portal: typeof import("@/app/api/portal/db/[siteId]/route");
  let internal: typeof import("@/app/api/internal/gateway/database/route");
  let fakeDataplane: Server;
  let priv: CryptoKey;
  let pubRaw: Uint8Array;
  let ticket = "";

  const check = (t: string) => internal.POST(new Request("http://x/api/internal/gateway/database", {
    method: "POST", headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET }, body: JSON.stringify({ ticket: t, clientIp: "203.0.113.5" }),
  }) as unknown as NextRequest);

  async function open(sealed: string): Promise<string> {
    const raw = Uint8Array.from(Buffer.from(sealed.slice(4), "base64"));
    const eph = await subtle.importKey("raw", raw.slice(0, 32), { name: "X25519" }, false, []);
    const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, priv, 256);
    const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...raw.slice(0, 32), ...pubRaw]), info: new TextEncoder().encode("captivo-access vault v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(32, 44), additionalData: seal.targetAAD(target) }, key, raw.slice(44)));
  }

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    priv = kp.privateKey;
    pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    const pub = Buffer.from(pubRaw).toString("base64");
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Db A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.46.0',$3)`, conn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions") VALUES($1,$2,$3,'CRM','DATABASE',true)`, site, tA.id, conn);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'v@a.test','Vendor','VENDOR','ACTIVE')`, vendor, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Session"(id,"tenantId","userId","tokenHash","expiresAt") VALUES($1,$2,$3,$4, now() + interval '1 day')`,
      session, tA.id, vendor, createHash("sha256").update(TOKEN).digest("hex"));
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
      if (rq.url === "/db-info") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ enabled: true, mysql: true }));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => fakeDataplane.listen(0, "127.0.0.1", r));
    process.env.DATAPLANE_URL = `http://127.0.0.1:${(fakeDataplane.address() as AddressInfo).port}`;
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    seal = await import("@/lib/vault/seal");
    portal = await import("@/app/api/portal/db/[siteId]/route");
    internal = await import("@/app/api/internal/gateway/database/route");
    const sealed = await seal.sealSecret(pub, "ro-password", target);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","dbParams","updatedAt") VALUES($1,$2,$3,'POSTGRES',$4,$5,$6,$7,$8,$9::jsonb,now())`,
      `dbav-${suffix}`, tA.id, site, target.host, target.port, target.username, sealed, pub, JSON.stringify({ database: "crm", databases: ["crm"], tls: "require", caCertPem: null }));
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    await new Promise((r) => fakeDataplane.close(r));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN", "RECORDING_ENABLED"]) delete process.env[k];
  });

  it("hands out a ticket bound to the sign-in and the grant's end, stored only hashed", async () => {
    const res = await portal.POST(new Request(`http://x/api/portal/db/${site}`, { method: "POST" }), { params: Promise.resolve({ siteId: site }) });
    expect(res.status).toBe(200);
    const j = await res.json();
    ticket = j.ticket;
    expect(ticket).toMatch(/^[a-z2-9]{24}$/);
    expect(j.database).toBe("crm");
    expect(j.recorded).toBe(true);
    const rows = await owner.$queryRawUnsafe<{ codeHash: string; sessionId: string; expiresAt: Date }[]>(`SELECT "codeHash","sessionId","expiresAt" FROM "DbTicket" WHERE "siteId" = $1`, site);
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toContain(ticket);
    expect(rows[0].sessionId).toBe(session);
    // The grant ends in two hours: the ticket does not outlive it.
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThan(2 * 3600_000 + 5000);
  });

  it("resolves the ticket to its tenant and a seal only the connector opens", async () => {
    const res = await check(ticket);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.tenantId).toBe(tA.id);
    expect(j.userId).toBe(vendor);
    expect(j.databases).toEqual(["crm"]);
    expect(j).not.toHaveProperty("secret");
    expect(j.connectors).toHaveLength(1);
    expect(await open(j.connectors[0].sealedSecret)).toBe("ro-password");
  });

  it("refuses an unknown ticket with 404", async () => {
    expect((await check("nosuchticketnosuchticket")).status).toBe(404);
  });

  it("refuses with 403 while the grant is revoked", async () => {
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'REVOKED' WHERE id = $1`, grant);
    expect((await check(ticket)).status).toBe(403);
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'ACTIVE' WHERE id = $1`, grant);
    expect((await check(ticket)).status).toBe(200);
  });

  it("refuses with 409 when the connector is too old to sign in", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.45.0' WHERE id = $1`, conn);
    const res = await check(ticket);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("connector_outdated");
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.46.0' WHERE id = $1`, conn);
  });

  it("serves a MySQL resource on its own port, from connector 2.51.0", async () => {
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET protocol = 'MYSQL' WHERE "siteId" = $1`, site);
    const old = await check(ticket);
    expect(old.status).toBe(409);
    expect((await old.json()).error).toBe("connector_outdated");
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.51.0' WHERE id = $1`, conn);
    const res = await portal.POST(new Request(`http://x/api/portal/db/${site}`, { method: "POST" }), { params: Promise.resolve({ siteId: site }) });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.engine).toBe("mysql");
    expect(j.port).toBe(13306);
    const c = await check(j.ticket);
    expect(c.status).toBe(200);
    expect((await c.json()).engine).toBe("mysql");
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET protocol = 'POSTGRES' WHERE "siteId" = $1`, site);
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.46.0' WHERE id = $1`, conn);
  });

  it("ends the ticket with the sign-in", async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Session" WHERE id = $1`, session);
    expect((await check(ticket)).status).toBe(404);
    const left = await owner.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "DbTicket" WHERE "siteId" = $1`, site);
    expect(Number(left[0].n)).toBe(0);
  });
});
