// SSH certificate sign-in against a real Postgres with RLS: the jump host's
// target lookup hands a recorded session the sealed "sshca" reference and the
// key id the server will log; a connector that predates certificates, or a
// resource whose recording was switched off afterwards, is refused with the
// reason instead of falling back to something that has no password.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `ca-a-${suffix}`, slug: `ca-a-${suffix}` };
const [newConn, oldConn] = [`ca-n-${suffix}`, `ca-o-${suffix}`];
const [okSite, oldSite, unrecSite, pwSite] = [`cas-ok-${suffix}`, `cas-old-${suffix}`, `cas-unrec-${suffix}`, `cas-pw-${suffix}`];
const ana = `ca-ana-${suffix}`;
const target = { host: "10.0.0.7", port: 22, username: "deploy" };

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("SSH certificate sign-in", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let ssh: typeof import("@/lib/gateway/native-ssh-target");
  const run = <T>(fn: () => Promise<T>) => withTenant(tA.id, fn);
  const look = (site: string) => run(() => ssh.nativeSshTarget(ana, site, new Date()));

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    const { sealSecret } = await import("@/lib/vault/seal");
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const pub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64");
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'CA A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'new',$1,'ONLINE','2.69.0',$3)`, newConn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'old',$1,'ONLINE','2.60.0',$3)`, oldConn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,$3,'Ana','VENDOR','ACTIVE')`, ana, tA.id, "ana@acme.test");
    const ref = await sealSecret(pub, '{"x":1}', target); // the reference text is opaque to the manager; any sealed value stands in
    const mk = async (site: string, connector: string, record: boolean, source: string | null) => {
      await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","nativeSsh","recordSessions") VALUES($1,$2,$3,$1,'GATEWAY',true,$4)`, site, tA.id, connector, record);
      await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId") VALUES($1,$2,$3,$4)`, `cag-${site}`, tA.id, ana, site);
      await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","secretSource","updatedAt") VALUES($1,$2,$3,'SSH',$4,$5,$6,$7,$8,$9,now())`, `cav-${site}`, tA.id, site, target.host, target.port, target.username, ref, pub, source);
    };
    await mk(okSite, newConn, true, "sshca");
    await mk(oldSite, oldConn, true, "sshca");
    await mk(unrecSite, newConn, false, "sshca");
    await mk(pwSite, newConn, true, null);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.VAULT_ENABLED = "true";
    process.env.ACCESS_DOMAIN = "example.test";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    ssh = await import("@/lib/gateway/native-ssh-target");
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "VAULT_ENABLED", "ACCESS_DOMAIN"]) delete process.env[k];
  });

  it("hands a recorded session the sealed reference and who is signing in", async () => {
    const t = await look(okSite);
    if (!t.ok || t.mode !== "recorded") throw new Error(JSON.stringify(t));
    expect(t.keyId).toBe("captivo:ana@acme.test");
    expect(t.connectors[0].sealedSecret).toMatch(/^cv1:/);
    expect(t.username).toBe("deploy");
  });

  it("needs a connector that can sign certificates", async () => {
    expect(await look(oldSite)).toMatchObject({ ok: false, error: "connector_outdated" });
    // The same connector with a password still works: only certificates need 2.69.0.
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "secretSource" = NULL WHERE "siteId" = $1`, oldSite);
    expect(await look(oldSite)).toMatchObject({ ok: true, mode: "recorded" });
  });

  it("is refused, not weakened, when recording is switched off afterwards", async () => {
    expect(await look(unrecSite)).toMatchObject({ ok: false, status: 409, error: "ssh_ca_needs_recording" });
  });

  it("leaves a password resource as it was", async () => {
    expect(await look(pwSite)).toMatchObject({ ok: true, mode: "recorded" });
  });
});
