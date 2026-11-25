// Account discovery against a real Postgres with RLS, through a stand-in data
// plane that answers the connector's "discover": the scan marks accounts that
// are already resources, a take-over creates resources whose password is
// sealed to the connector and carries the host key and the administrator
// account over, and refuses the administrator account itself.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NextRequest } from "next/server";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `di-a-${suffix}`, slug: `di-a-${suffix}` };
const conn = `di-c-${suffix}`;
const site = `dis-${suffix}`;
const winSite = `disw-${suffix}`;
const dbSite = `disd-${suffix}`;
const admin = `di-adm-${suffix}`;
const DP_SECRET = `di-dp-${suffix}`;
const target = { host: "10.0.0.7", port: 22, username: "ana" };

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: `di-adm-${process.env.DI_SUFFIX}`, email: "admin@a.test", role: "ADMIN" }) }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

const ACCOUNTS = [
  { name: "root", uid: 0, shell: "/bin/bash", home: "/root", admin: true, login: true, passAgeDays: 400 },
  { name: "ana", uid: 1000, shell: "/bin/bash", home: "/home/ana", login: true, passAgeDays: 30 },
  { name: "deploy", uid: 1001, shell: "/bin/bash", home: "/home/deploy", login: true, passAgeDays: 90 },
  { name: "ops", uid: 1002, shell: "/bin/bash", home: "/home/ops", admin: true, login: true, passAgeDays: 5 },
  { name: "daemon", uid: 1, shell: "/usr/sbin/nologin", home: "/usr/sbin", locked: true, passAgeDays: -1 },
];

describe.skipIf(!OWNER_URL)("account discovery", () => {
  let owner: PrismaClient;
  let route: typeof import("@/app/api/admin/sites/[id]/discovery/route");
  let fakeDataplane: Server;
  const asked: Record<string, unknown>[] = [];

  const post = (body: Record<string, unknown>, id = site) => route.POST(new Request(`http://x/api/admin/sites/${id}/discovery`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as NextRequest, { params: Promise.resolve({ id }) });

  beforeAll(async () => {
    process.env.DI_SUFFIX = suffix;
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const pub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64");
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.VAULT_ENABLED = "true";
    process.env.ACCESS_DOMAIN = "example.test";
    fakeDataplane = createServer(async (rq, res) => {
      let raw = "";
      for await (const chunk of rq) raw += chunk;
      if (rq.headers["x-dataplane-secret"] !== DP_SECRET || rq.url !== "/vault-rotate") return void res.writeHead(404).end();
      const { request } = JSON.parse(raw) as { request: Record<string, unknown> };
      asked.push(request);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome: "ok", accounts: ACCOUNTS }));
    });
    await new Promise<void>((r) => fakeDataplane.listen(0, "127.0.0.1", r));
    process.env.DATAPLANE_URL = `http://127.0.0.1:${(fakeDataplane.address() as AddressInfo).port}`;

    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Di A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.76.0',$3)`, conn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'admin@a.test','Admin','ADMIN','ACTIVE')`, admin, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions") VALUES($1,$2,$3,'Build box','GATEWAY',true)`, site, tA.id, conn);
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    const { sealSecret } = await import("@/lib/vault/seal");
    const s = await sealSecret(pub, "ana-pass", target);
    const r = await sealSecret(pub, "root-pass", { host: target.host, port: target.port, username: "ops" }, "reconcile");
    await owner.$executeRawUnsafe(
      `INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","sshHostKey","reconcileUsername","reconcileKind","reconcileSeals","updatedAt") VALUES($1,$2,$3,'SSH',$4,$5,$6,$7,$8,'SHA256:hostkey','ops','PASSWORD',$9::jsonb,now())`,
      `div-${suffix}`, tA.id, site, target.host, target.port, target.username, s, pub, JSON.stringify({ [pub]: r }),
    );
    // A Windows server: a local account, the built-in Administrator as the administrator account.
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions","nativeRdp") VALUES($1,$2,$3,'File server','GATEWAY',true,true)`, winSite, tA.id, conn);
    const ws = await sealSecret(pub, "alice-pass", { host: "10.0.0.9", port: 3389, username: "alice" });
    const wr = await sealSecret(pub, "admin-pass", { host: "10.0.0.9", port: 3389, username: "Administrator" }, "reconcile");
    await owner.$executeRawUnsafe(
      `INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","rotationAccount","reconcileUsername","reconcileKind","reconcileSeals","updatedAt") VALUES($1,$2,$3,'RDP',$4,3389,'alice',$5,$6,'local','Administrator','PASSWORD',$7::jsonb,now())`,
      `divw-${suffix}`, tA.id, winSite, "10.0.0.9", ws, pub, JSON.stringify({ [pub]: wr }),
    );
    // A PostgreSQL server whose administrator role is the saved reconcile account.
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions") VALUES($1,$2,$3,'Orders DB','DATABASE',true)`, dbSite, tA.id, conn);
    const ds = await sealSecret(pub, "app-pass", { host: "10.0.0.8", port: 5432, username: "app" });
    const dr = await sealSecret(pub, "prov-pass", { host: "10.0.0.8", port: 5432, username: "prov" }, "reconcile");
    await owner.$executeRawUnsafe(
      `INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","dbParams","reconcileUsername","reconcileKind","reconcileSeals","updatedAt") VALUES($1,$2,$3,'POSTGRES',$4,5432,'app',$5,$6,$7::jsonb,'prov','PASSWORD',$8::jsonb,now())`,
      `divd-${suffix}`, tA.id, dbSite, "10.0.0.8", ds, pub, JSON.stringify({ database: "orders", databases: [], tls: "require", caCertPem: null, sessionRole: "reader" }), JSON.stringify({ [pub]: dr }),
    );
    route = await import("@/app/api/admin/sites/[id]/discovery/route");
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    await new Promise((r) => fakeDataplane.close(r));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN", "DI_SUFFIX"]) delete process.env[k];
  });

  it("lists the server's accounts through the administrator account, marking the ones that are already resources", async () => {
    const res = await post({ action: "scan" });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.administrator).toBe("ops");
    expect(j.accounts).toHaveLength(5);
    expect(j.accounts.find((a: { name: string }) => a.name === "ana").managedBy).toMatchObject({ id: site });
    expect(j.accounts.find((a: { name: string }) => a.name === "deploy").managedBy).toBeNull();
    const req = asked[0] as { op: string; method: string; reconcile: { username: string; sealed: string } };
    expect(req).toMatchObject({ op: "discover", method: "linux", host: "10.0.0.7", port: "22" });
    expect(req.reconcile.username).toBe("ops");
    expect(req.reconcile.sealed).toMatch(/^cv1:/);
  });

  it("takes accounts over as resources sealed to the connector, and refuses the ones it must not", async () => {
    const res = await post({ action: "adopt", accounts: ["deploy", "ops", "ana", "daemon", "root", "ghost"] });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.created.map((c: { username: string }) => c.username)).toEqual(["deploy"]);
    expect(Object.fromEntries(j.refused.map((r: { name: string; reason: string }) => [r.name, r.reason]))).toMatchObject({
      ops: expect.stringContaining("administrator account"), ana: expect.stringContaining("Already a resource"), daemon: expect.stringContaining("no shell"), root: expect.stringContaining("root"), ghost: expect.stringContaining("any more"),
    });
    const rows = await owner.$queryRawUnsafe<{ secret: string; sealedTo: string; sshHostKey: string; reconcileUsername: string; rotateDueAt: Date | null; name: string; recordSessions: boolean }[]>(
      `SELECT v.secret, v."sealedTo", v."sshHostKey", v."reconcileUsername", v."rotateDueAt", s.name, s."recordSessions" FROM "VaultCredential" v JOIN "Site" s ON s.id = v."siteId" WHERE v.username = 'deploy' AND s."tenantId" = $1`, tA.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sealedTo: expect.any(String), sshHostKey: "SHA256:hostkey", reconcileUsername: "ops", name: "Build box · deploy", recordSessions: true });
    expect(rows[0].secret).toMatch(/^cv1:/);
    expect(rows[0].rotateDueAt).not.toBeNull();
    // A second time it is already a resource.
    const again = await (await post({ action: "adopt", accounts: ["deploy"] })).json();
    expect(again.created).toHaveLength(0);
  });

  it("lists a Windows server's local accounts the same way, and takes one over as a remote-desktop resource", async () => {
    asked.length = 0;
    const scan = await (await post({ action: "scan" }, winSite)).json();
    expect(scan.platform).toBe("windows");
    expect(asked[0]).toMatchObject({ op: "discover", method: "windows", host: "10.0.0.9" });
    expect((asked[0] as { reconcile: { username: string } }).reconcile.username).toBe("Administrator");
    const res = await post({ action: "adopt", accounts: ["deploy", "root"] }, winSite);
    const j = await res.json();
    expect(j.created.map((c: { username: string }) => c.username)).toEqual(["deploy", "root"]);
    const rows = await owner.$queryRawUnsafe<{ protocol: string; rotationAccount: string; reconcileUsername: string; name: string }[]>(
      `SELECT v.protocol, v."rotationAccount", v."reconcileUsername", s.name FROM "VaultCredential" v JOIN "Site" s ON s.id = v."siteId" WHERE v.username = 'deploy' AND v."targetHost" = '10.0.0.9' AND s."tenantId" = $1`, tA.id);
    expect(rows).toEqual([{ protocol: "RDP", rotationAccount: "local", reconcileUsername: "Administrator", name: "File server · deploy" }]);
  });

  it("lists a database server's users and takes one over as a database resource, without the session role", async () => {
    asked.length = 0;
    const scan = await (await post({ action: "scan" }, dbSite)).json();
    expect(scan.platform).toBe("postgres");
    expect(asked[0]).toMatchObject({ op: "discover", method: "postgres", host: "10.0.0.8", db: { database: "orders", tls: "require" } });
    const j = await (await post({ action: "adopt", accounts: ["deploy", "prov"] }, dbSite)).json();
    expect(j.created.map((c: { username: string }) => c.username)).toEqual(["deploy"]);
    expect(j.refused[0]).toMatchObject({ name: "prov" });
    const rows = await owner.$queryRawUnsafe<{ protocol: string; mode: string; dbParams: { database: string; sessionRole: string }; guacParams: unknown; reconcileUsername: string }[]>(
      `SELECT v.protocol, s."accessMode" AS mode, v."dbParams", v."guacParams", v."reconcileUsername" FROM "VaultCredential" v JOIN "Site" s ON s.id = v."siteId" WHERE v.username = 'deploy' AND v."targetHost" = '10.0.0.8' AND s."tenantId" = $1`, tA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ protocol: "POSTGRES", mode: "DATABASE", reconcileUsername: "prov" });
    expect(rows[0].dbParams).toMatchObject({ database: "orders", sessionRole: "" });
    expect(rows[0].guacParams).toBeNull();
  });

  it("asks for one to twenty accounts", async () => {
    expect((await post({ action: "adopt", accounts: [] })).status).toBe(400);
    expect((await post({ action: "adopt", accounts: Array.from({ length: 21 }, (_, i) => `u${i}`) })).status).toBe(400);
  });
});
