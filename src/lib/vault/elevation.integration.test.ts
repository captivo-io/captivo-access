// Administrator rights during a session, from the control plane's side, against
// a real Postgres with RLS: the browser session's descriptor and the native
// RDP target carry who gives the rights (Linux sudo, Windows Administrators
// group) and each connector's own seal; a connector too old, or without a copy
// of the administrator account, is refused rather than opening a session
// without the rights.
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
const tA = { id: `el-a-${suffix}`, slug: `el-a-${suffix}` };
const [newConn, oldConn] = [`el-n-${suffix}`, `el-o-${suffix}`];
const ana = `el-ana-${suffix}`;
const DP_SECRET = `el-dp-${suffix}`;
const T = { host: "10.0.0.7" };
const sites = { ssh: `els-ssh-${suffix}`, rdp: `els-rdp-${suffix}`, old: `els-old-${suffix}`, bare: `els-bare-${suffix}`, off: `els-off-${suffix}` };

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("administrator rights during sessions", () => {
  let owner: PrismaClient;
  let descriptor: typeof import("@/app/api/internal/gateway/descriptor/route");
  let rdp: typeof import("@/lib/gateway/native-rdp-target");
  let pub = "";
  let adminSeal = "";
  const run = async (siteId: string) => {
    const res = await descriptor.POST(new Request("http://x/api/internal/gateway/descriptor", { method: "POST", headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET }, body: JSON.stringify({ userId: ana, siteId }) }) as unknown as NextRequest);
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    pub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64");
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.VAULT_ENABLED = "true";
    process.env.ACCESS_DOMAIN = "example.test";
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'El A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'new',$1,'ONLINE','2.75.0',$3)`, newConn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'old',$1,'ONLINE','2.72.0',$3)`, oldConn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'ana@a.test','Ana','VENDOR','ACTIVE')`, ana, tA.id);
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    const { sealSecret } = await import("@/lib/vault/seal");
    const pw = await sealSecret(pub, "pw", { host: T.host, port: 22, username: "deploy" });
    adminSeal = await sealSecret(pub, "admin-pass", { host: T.host, port: 22, username: "root" }, "reconcile");
    const mk = async (id: string, connector: string, protocol: "SSH" | "RDP", elevate: boolean, withSeal: boolean, extra = "") => {
      await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions","nativeRdp") VALUES($1,$2,$3,$1,'GATEWAY',true,${protocol === "RDP" ? "true" : "false"})`, id, tA.id, connector);
      await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId") VALUES($1,$2,$3,$4)`, `elg-${id}`, tA.id, ana, id);
      await owner.$executeRawUnsafe(
        `INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo",elevate,"reconcileUsername","reconcileKind","reconcileSeals","sshHostKey","updatedAt") VALUES($1,$2,$3,$4::"VaultProtocol",$5,$6,'deploy',$7,$8,$9,${elevate ? "'root'" : "NULL"},'PASSWORD',$10::jsonb,${extra || "NULL"},now())`,
        `elv-${id}`, tA.id, id, protocol, T.host, protocol === "SSH" ? 22 : 3389, pw, pub, elevate, JSON.stringify(withSeal ? { [pub]: adminSeal } : {}),
      );
    };
    await mk(sites.ssh, newConn, "SSH", true, true, "'SHA256:pinned'");
    await mk(sites.rdp, newConn, "RDP", true, true);
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "guacParams" = '{"domain":"CORP"}'::jsonb WHERE "siteId" = $1`, sites.rdp);
    await mk(sites.old, oldConn, "SSH", true, true);
    await mk(sites.bare, newConn, "SSH", true, false);
    await mk(sites.off, newConn, "SSH", false, false);
    descriptor = await import("@/app/api/internal/gateway/descriptor/route");
    rdp = await import("@/lib/gateway/native-rdp-target");
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "ACCESS_DOMAIN"]) delete process.env[k];
  });

  it("a browser session on a Linux server carries the sudo account, its seal and the pinned host key", async () => {
    const r = await run(sites.ssh);
    expect(r.status).toBe(200);
    expect(r.body.elevate).toEqual({ platform: "linux", username: "root", kind: "PASSWORD" });
    expect(r.body.sshHostKey).toBe("SHA256:pinned");
    expect(r.body.connectors[0].elevateSealed).toBe(adminSeal);
  });

  it("a browser session on a Windows server carries the Administrators-group account", async () => {
    const r = await run(sites.rdp);
    expect(r.status).toBe(200);
    expect(r.body.elevate.platform).toBe("windows");
    // The domain kept apart from the user name is put back together for the server to look up.
    expect(r.body.elevate.account).toBe("CORP\\deploy");
    expect(r.body.connectors[0].elevateSealed).toBe(adminSeal);
  });

  it("a resource without the setting carries nothing extra", async () => {
    const r = await run(sites.off);
    expect(r.status).toBe(200);
    expect(r.body.elevate).toBeUndefined();
    expect(r.body.connectors[0].elevateSealed).toBeUndefined();
  });

  it("does not open a session without the rights it should have: a connector too old, or without the account's seal", async () => {
    expect(await run(sites.old)).toMatchObject({ status: 409, body: { error: "connector_outdated" } });
    expect(await run(sites.bare)).toMatchObject({ status: 409, body: { error: "elevate_reenter" } });
  });

  it("recorded native RDP carries the same", async () => {
    const t = await (await import("@/lib/tenant/scope")).withTenant(tA.id, () => rdp.nativeRdpTarget(ana, sites.rdp, new Date()));
    if (!t.ok || t.mode !== "recorded") throw new Error(JSON.stringify(t));
    expect(t.elevate?.platform).toBe("windows");
    expect(t.elevate?.account).toBe("CORP\\deploy");
    expect(t.connectors[0].elevateSealed).toBe(adminSeal);
  });
});
