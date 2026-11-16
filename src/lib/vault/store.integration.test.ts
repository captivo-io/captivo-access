// Sealed vault secrets against a real Postgres with RLS: legacy secrets are
// sealed once the connector reports its key, a re-keyed connector leaves them
// stale (re-entry), a sealed secret is kept only while its target and
// connector stay the same, and the vault API refuses another tenant's resource.
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
const tA = { id: `vault-a-${suffix}`, slug: `vault-a-${suffix}` };
const tB = { id: `vault-b-${suffix}`, slug: `vault-b-${suffix}` };
const subtle = globalThis.crypto.subtle;

let mockHost = "";
vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-forwarded-host", mockHost]]) as unknown as Headers,
}));
vi.mock("@/lib/current-user", () => ({
  getCurrentUser: async () => ({ id: `vault-admin-${suffix}`, email: "admin@a.test", role: "ADMIN" }),
}));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

async function connectorKey() {
  const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pubRaw, pub: Buffer.from(pubRaw).toString("base64") };
}

// connector/vault.go's open, for checking what the cloud stored.
async function open(k: Awaited<ReturnType<typeof connectorKey>>, sealed: string, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = Uint8Array.from(Buffer.from(sealed.slice(4), "base64"));
  const eph = await subtle.importKey("raw", raw.slice(0, 32), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, k.priv, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...raw.slice(0, 32), ...k.pubRaw]), info: new TextEncoder().encode("captivo-access vault v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(32, 44), additionalData: aad }, key, raw.slice(44)));
}

describe.skipIf(!OWNER_URL)("sealed vault secrets", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let store: typeof import("@/lib/vault/store");
  let seal: typeof import("@/lib/vault/seal");
  let PUT: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  const target = { host: "10.0.0.5", port: 3389, username: "admin" };

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    for (const t of [tA, tB]) {
      await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Vault test','ACTIVE')`, t.id, t.slug);
      await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash") VALUES($1,$2,'c',$3)`, `conn-${t.id}`, t.id, `h-${t.id}`);
      await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode") VALUES($1,$2,$3,'rdp','GATEWAY')`, `site-${t.id}`, t.id, `conn-${t.id}`);
    }
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ACCESS_DOMAIN = "example.test";
    process.env.MANAGER_PUBLIC_URL = "https://manager.example.test";
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.VAULT_ENABLED = "true";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    store = await import("@/lib/vault/store");
    seal = await import("@/lib/vault/seal");
    ({ PUT } = await import("@/app/api/admin/sites/[id]/vault/route"));
  });

  afterAll(async () => {
    for (const t of [tA, tB]) {
      await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, t.id);
    }
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ACCESS_DOMAIN", "MANAGER_PUBLIC_URL", "ENCRYPTION_KEY", "VAULT_ENABLED"]) delete process.env[k];
  });

  it("keeps a legacy secret until the connector reports a key, then seals it for its target", async () => {
    const site = `site-${tA.id}`;
    const conn = `conn-${tA.id}`;
    await withTenant(tA.id, () => store.setVaultCredential({ siteId: site, connectorId: conn, protocol: "RDP", targetHost: target.host, targetPort: target.port, username: target.username, secret: { secret: "pw-1" }, secretKind: "PASSWORD" }));
    let cred = await withTenant(tA.id, () => store.getVaultCredential(site));
    expect(cred).toMatchObject({ secret: "pw-1", sealedSecret: null, stale: false });

    const k = await connectorKey();
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET "vaultPublicKey" = $1 WHERE id = $2`, k.pub, conn);
    expect(await withTenant(tA.id, () => store.sealLegacyCredentials({ connectorId: conn }))).toBe(1);
    expect(await withTenant(tA.id, () => store.sealLegacyCredentials({ connectorId: conn }))).toBe(0);

    cred = await withTenant(tA.id, () => store.getVaultCredential(site));
    expect(cred?.secret).toBeNull();
    expect(cred?.stale).toBe(false);
    expect(await open(k, cred!.sealedSecret!, seal.targetAAD(target))).toBe("pw-1");
    // Nothing in the row the cloud could open any more.
    const row = (await owner.$queryRawUnsafe(`SELECT secret, "sealedTo" FROM "VaultCredential" WHERE "siteId" = $1`, site)) as { secret: string; sealedTo: string }[];
    expect(row[0].secret.startsWith("cv1:")).toBe(true);
    expect(row[0].sealedTo).toBe(k.pub);

    // Kept only while the target and the connector's key stay the same.
    expect(await withTenant(tA.id, () => store.keptSecretStillOpens(site, conn, target))).toBe(true);
    expect(await withTenant(tA.id, () => store.keptSecretStillOpens(site, conn, { ...target, host: "10.0.0.6" }))).toBe(false);

    // A browser-sealed value for a key the connector no longer has is refused.
    const old = await connectorKey();
    const forOld = await seal.sealSecret(old.pub, "pw-2", target);
    await expect(withTenant(tA.id, () => store.storedSecretFor(conn, { sealedSecret: forOld, sealedTo: old.pub }, target))).rejects.toThrow("vault_key_changed");

    // The connector re-keyed (its data was lost): the secret is stale.
    const k2 = await connectorKey();
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET "vaultPublicKey" = $1 WHERE id = $2`, k2.pub, conn);
    expect((await withTenant(tA.id, () => store.getVaultCredential(site)))?.stale).toBe(true);
    expect((await withTenant(tA.id, () => store.getVaultCredentialMeta(site)))?.stale).toBe(true);
    expect(await withTenant(tA.id, () => store.keptSecretStillOpens(site, conn, target))).toBe(false);

    // A plaintext secret through the API is sealed on the server to the current key.
    await withTenant(tA.id, () => store.setVaultCredential({ siteId: site, connectorId: conn, protocol: "RDP", targetHost: target.host, targetPort: target.port, username: target.username, secret: { secret: "pw-3" }, secretKind: "PASSWORD" }));
    cred = await withTenant(tA.id, () => store.getVaultCredential(site));
    expect(cred?.stale).toBe(false);
    expect(await open(k2, cred!.sealedSecret!, seal.targetAAD(target))).toBe("pw-3");
  });

  it("the vault API refuses another tenant's resource and writes nothing", async () => {
    mockHost = `${tA.slug}.example.test`;
    const req = new Request("http://tenant/api/admin/sites/x/vault", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "RDP", targetHost: "h", targetPort: 3389, username: "u", secret: "s" }),
    }) as unknown as NextRequest;
    const res = await PUT(req, { params: Promise.resolve({ id: `site-${tB.id}` }) });
    expect(res.status).toBe(404);
    const rows = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "VaultCredential" WHERE "siteId" = $1`, `site-${tB.id}`)) as { n: number }[];
    expect(rows[0].n).toBe(0);
  });
});
