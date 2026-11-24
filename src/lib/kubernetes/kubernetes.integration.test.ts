// Kubernetes access against a real Postgres with RLS: the portal hands out a
// kubeconfig whose token is a ticket tied to the browser session, stored only
// hashed; the proxy's check (POST /api/internal/gateway/kubernetes) resolves
// its tenant from the ticket and answers with the API server, the token
// sealed so only the resource's connector opens it, who the requests act as
// and the resource's rules; an unknown ticket, a revoked grant, a signed-out
// session and a too-old connector are each refused with the status the proxy
// acts on.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `k8a-a-${suffix}`, slug: `k8a-a-${suffix}` };
const conn = `k8a-c-${suffix}`;
const site = `k8as-${suffix}`;
const vendor = `k8a-v-${suffix}`;
const session = `k8a-sess-${suffix}`;
const grant = `k8a-g-${suffix}`;
const TOKEN = `k8a-token-${suffix}-0123456789`;
const DP_SECRET = `k8a-dp-${suffix}`;
const subtle = globalThis.crypto.subtle;
const target = { host: "10.0.0.5", port: 6443, username: "captivo-access" };

vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers,
  cookies: async () => ({ get: (n: string) => (n === "ca_session" ? { value: TOKEN } : undefined) }),
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: vendor, email: "ana@northwind.test", role: "VENDOR" }) }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("kubernetes access", () => {
  let owner: PrismaClient;
  let seal: typeof import("@/lib/vault/seal");
  let portal: typeof import("@/app/api/portal/kube/[siteId]/route");
  let internal: typeof import("@/app/api/internal/gateway/kubernetes/route");
  let priv: CryptoKey;
  let pubRaw: Uint8Array;
  let ticket = "";

  const check = (t: string) => internal.POST(new Request("http://x/api/internal/gateway/kubernetes", {
    method: "POST", headers: { "content-type": "application/json", "x-dataplane-secret": DP_SECRET }, body: JSON.stringify({ ticket: t, clientIp: "203.0.113.5" }),
  }) as unknown as NextRequest);
  const kubeconfig = () => portal.POST(new Request(`https://${tA.slug}.example.test/api/portal/kube/${site}`, { method: "POST" }), { params: Promise.resolve({ siteId: site }) });

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
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'K8s A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.62.0',$3)`, conn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","recordSessions","keystrokeLogging") VALUES($1,$2,$3,'Prod cluster','KUBERNETES',true,true)`, site, tA.id, conn);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'ana@northwind.test','Ana','VENDOR','ACTIVE')`, vendor, tA.id);
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
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    seal = await import("@/lib/vault/seal");
    portal = await import("@/app/api/portal/kube/[siteId]/route");
    internal = await import("@/app/api/internal/gateway/kubernetes/route");
    const sealed = await seal.sealSecret(pub, "sa-token", target);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","kubeParams","updatedAt") VALUES($1,$2,$3,'KUBERNETES',$4,$5,$6,$7,$8,$9::jsonb,now())`,
      `k8av-${suffix}`, tA.id, site, target.host, target.port, target.username, sealed, pub,
      JSON.stringify({ caCertPem: null, identity: "impersonate", groups: ["captivo-users", "northwind"], namespaces: ["web"], readOnly: true, portForward: false }));
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "ACCESS_DOMAIN", "RECORDING_ENABLED"]) delete process.env[k];
  });

  it("hands out a kubeconfig whose token is bound to the sign-in and the grant's end, stored only hashed", async () => {
    const res = await kubeconfig();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.server).toMatch(new RegExp(`/k8s/${site}$`));
    expect(j.kubeconfig).toContain(`server: ${j.server}`);
    expect(j.kubeconfig).toContain("namespace: web");
    ticket = /token: ([a-z2-9]{24})/.exec(j.kubeconfig)?.[1] ?? "";
    expect(ticket).not.toBe("");
    expect(j).toMatchObject({ readOnly: true, namespaces: ["web"], actsAs: "ana@northwind.test", recorded: true, fileName: "captivo-prod-cluster.yaml" });
    const rows = await owner.$queryRawUnsafe<{ codeHash: string; sessionId: string; expiresAt: Date }[]>(`SELECT "codeHash","sessionId","expiresAt" FROM "DbTicket" WHERE "siteId" = $1`, site);
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toContain(ticket);
    expect(rows[0].sessionId).toBe(session);
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThan(2 * 3600_000 + 5000);
  });

  it("resolves the token to its tenant, the rules, who acts, and a seal only the connector opens", async () => {
    const res = await check(ticket);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({
      tenantId: tA.id, siteId: site, userId: vendor, targetHost: "10.0.0.5", targetPort: 6443, username: "captivo-access",
      impersonateUser: "ana@northwind.test", impersonateGroups: ["captivo-users", "northwind"], readOnly: true, namespaces: ["web"], portForward: false,
      record: true, keystrokeLogging: true,
    });
    expect(j).not.toHaveProperty("secret");
    expect(await open(j.connectors[0].sealedSecret)).toBe("sa-token");
  });

  it("acts as the service account itself when the resource says so", async () => {
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "kubeParams" = jsonb_set("kubeParams", '{identity}', '"service_account"') WHERE "siteId" = $1`, site);
    const j = await (await check(ticket)).json();
    expect(j.impersonateUser).toBe("");
    expect(j.impersonateGroups).toEqual([]);
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "kubeParams" = jsonb_set("kubeParams", '{identity}', '"impersonate"') WHERE "siteId" = $1`, site);
  });

  it("refuses an unknown token with 404", async () => {
    expect((await check("nosuchticketnosuchticket")).status).toBe(404);
  });

  it("refuses with 403 while the grant is revoked", async () => {
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'REVOKED' WHERE id = $1`, grant);
    expect((await check(ticket)).status).toBe(403);
    expect((await kubeconfig()).status).toBe(403);
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'ACTIVE' WHERE id = $1`, grant);
    expect((await check(ticket)).status).toBe(200);
  });

  it("refuses with 409 when the connector is too old", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.61.1' WHERE id = $1`, conn);
    const res = await check(ticket);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("connector_outdated");
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.62.0' WHERE id = $1`, conn);
  });

  it("ends with the browser session (signing out)", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Session" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, session);
    expect((await check(ticket)).status).toBe(404);
  });
});
