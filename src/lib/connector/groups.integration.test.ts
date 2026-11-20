// Connector groups against a real Postgres with RLS: a group resource's secret
// is sealed to every member and the gateway descriptor hands each member its
// own seal; a member that joins later is left out until the secret is entered
// again; a revoked member's resources move to another member; a legacy secret
// waits until every member has a key; and a group cannot take another
// tenant's connector.
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
const tA = { id: `cg-a-${suffix}`, slug: `cg-a-${suffix}` };
const tB = { id: `cg-b-${suffix}`, slug: `cg-b-${suffix}` };
const [c1, c2, c3, cB] = ["c1", "c2", "c3", "cB"].map((n) => `${n}-${suffix}`);
const site = `cgs-${suffix}`;
const user = `cgu-${suffix}`;
const DP_SECRET = `cg-dp-${suffix}`;
const subtle = globalThis.crypto.subtle;
const target = { host: "10.0.0.5", port: 3389, username: "admin" };

vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: `cg-admin-${suffix}`, email: "admin@a.test", role: "ADMIN" }) }));

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
type Key = Awaited<ReturnType<typeof connectorKey>>;

// connector/vault.go's open, for checking what each member was handed.
async function open(k: Key, sealed: string, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = Uint8Array.from(Buffer.from(sealed.slice(4), "base64"));
  const eph = await subtle.importKey("raw", raw.slice(0, 32), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, k.priv, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...raw.slice(0, 32), ...k.pubRaw]), info: new TextEncoder().encode("captivo-access vault v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(32, 44), additionalData: aad }, key, raw.slice(44)));
}

describe.skipIf(!OWNER_URL)("connector groups", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let store: typeof import("@/lib/vault/store");
  let seal: typeof import("@/lib/vault/seal");
  let groups: typeof import("@/lib/connector/groups");
  let saveConnectorGroup: typeof import("@/lib/connector/group-save").saveConnectorGroup;
  let db: typeof import("@/lib/db").db;
  let descriptor: (req: NextRequest) => Promise<Response>;
  const keys: Record<string, Key> = {};
  let groupId = "";

  const describeSession = async () => {
    const res = await descriptor(new Request("http://internal/api/internal/gateway/descriptor", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET },
      body: JSON.stringify({ userId: user, siteId: site }),
    }) as unknown as NextRequest);
    return { status: res.status, body: (await res.json()) as { connectors?: { id: string; standby?: boolean; sealedSecret?: string }[]; connectorId?: string; error?: string } };
  };

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    for (const n of [c1, c2, c3]) keys[n] = await connectorKey();
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'CG A','ACTIVE'),($3,$4,'CG B','ACTIVE')`, tA.id, tA.slug, tB.id, tB.slug);
    for (const n of [c1, c2]) {
      await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,"vaultPublicKey") VALUES($1,$2,$1,$1,'ONLINE',$3)`, n, tA.id, keys[n].pub);
    }
    // c3 has not reported a key yet (an old connector).
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status) VALUES($1,$2,$1,$1,'ONLINE')`, c3, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status) VALUES($1,$2,$1,$1,'ONLINE')`, cB, tB.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode") VALUES($1,$2,$3,'dc','GATEWAY')`, site, tA.id, c1);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'v@a.test','V','VENDOR','ACTIVE')`, user, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId",status) VALUES($1,$2,$3,$4,'ACTIVE')`, `cgg-${suffix}`, tA.id, user, site);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.VAULT_ENABLED = "true";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    store = await import("@/lib/vault/store");
    seal = await import("@/lib/vault/seal");
    groups = await import("@/lib/connector/groups");
    ({ saveConnectorGroup } = await import("@/lib/connector/group-save"));
    ({ db } = await import("@/lib/db"));
    ({ POST: descriptor } = await import("@/app/api/internal/gateway/descriptor/route"));
  });

  afterAll(async () => {
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, t.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED"]) delete process.env[k];
  });

  it("seals a group resource's secret to every member and hands each its own", async () => {
    groupId = await withTenant(tA.id, () => saveConnectorGroup(null, "DC", [{ connectorId: c1, standby: false }, { connectorId: c2, standby: true }]));
    await withTenant(tA.id, () => db.site.update({ where: { id: site }, data: { connectorGroupId: groupId } }));
    await withTenant(tA.id, () => store.setVaultCredential({ siteId: site, connectorId: c1, connectorGroupId: groupId, protocol: "RDP", targetHost: target.host, targetPort: target.port, username: target.username, secret: { secret: "pw-1" }, secretKind: "PASSWORD" }));

    const { status, body } = await describeSession();
    expect(status).toBe(200);
    expect(body.connectors?.map((c) => [c.id, !!c.standby])).toEqual([[c1, false], [c2, true]]);
    const aad = seal.targetAAD(target);
    for (const c of body.connectors!) expect(await open(keys[c.id], c.sealedSecret!, aad)).toBe("pw-1");
    // Each seal opens only with its own member's key.
    await expect(open(keys[c2], body.connectors![0].sealedSecret!, aad)).rejects.toThrow();
  });

  it("leaves out a member that joined after the secret was saved, until it is entered again", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET "vaultPublicKey" = $2 WHERE id = $1`, c3, keys[c3].pub);
    await withTenant(tA.id, () => saveConnectorGroup(groupId, "DC", [{ connectorId: c1, standby: false }, { connectorId: c2, standby: true }, { connectorId: c3, standby: false }]));
    let { body } = await describeSession();
    expect(body.connectors?.map((c) => c.id)).toEqual([c1, c2]);
    // A browser-sealed re-entry covering all three.
    const aadTarget = target;
    const sealed = Object.fromEntries(await Promise.all([c1, c2, c3].map(async (n) => [keys[n].pub, await seal.sealSecret(keys[n].pub, "pw-2", aadTarget)] as const)));
    const { [keys[c1].pub]: first, ...extra } = sealed;
    await withTenant(tA.id, () => store.setVaultCredential({ siteId: site, connectorId: c1, connectorGroupId: groupId, protocol: "RDP", targetHost: target.host, targetPort: target.port, username: target.username, secret: { sealedSecret: first, sealedTo: keys[c1].pub, extraSeals: extra }, secretKind: "PASSWORD" }));
    ({ body } = await describeSession());
    expect(body.connectors?.map((c) => c.id)).toEqual([c1, c3, c2]); // actives first
    expect(await open(keys[c3], body.connectors![1].sealedSecret!, seal.targetAAD(target))).toBe("pw-2");
  });

  it("moves a revoked member's resources onto another member", async () => {
    await withTenant(tA.id, () => groups.releaseConnectorFromGroups(db, c1));
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET status = 'REVOKED' WHERE id = $1`, c1);
    const s = await withTenant(tA.id, () => db.site.findUnique({ where: { id: site }, select: { connectorId: true } }));
    expect(s?.connectorId).toBe(c3);
    const { body } = await describeSession();
    expect(body.connectors?.map((c) => c.id)).toEqual([c3, c2]);
  });

  it("seals a legacy secret only once every member has a key", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET "vaultPublicKey" = NULL WHERE id = $1`, c3);
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET secret = $2, "sealedTo" = NULL, "extraSeals" = NULL WHERE "siteId" = $1`, site, (await import("@/lib/crypto")).encrypt("pw-3"));
    expect(await withTenant(tA.id, () => store.sealLegacyCredentials({ connectorId: c2 }))).toBe(0);
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET "vaultPublicKey" = $2 WHERE id = $1`, c3, keys[c3].pub);
    expect(await withTenant(tA.id, () => store.sealLegacyCredentials({ connectorId: c3 }))).toBe(1);
    const { body } = await describeSession();
    for (const c of body.connectors!) expect(await open(keys[c.id], c.sealedSecret!, seal.targetAAD(target))).toBe("pw-3");
  });

  it("can't take another tenant's connector", async () => {
    await expect(withTenant(tA.id, () => saveConnectorGroup(null, "Foreign", [{ connectorId: cB, standby: false }]))).rejects.toThrow("connector_not_found");
    const seen = await withTenant(tB.id, () => db.connectorGroup.findMany({ select: { id: true } }));
    expect(seen).toEqual([]);
  });
});
