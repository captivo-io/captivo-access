// Password check-out against a real Postgres with RLS, through a stand-in
// dataplane that does what connector/rotate.go does: a person with an active
// grant takes the saved password sealed to a key only their browser holds; a
// second person is told it is taken; rotation leaves it alone while it is out;
// when it is returned the password is changed, so what the person holds stops
// working; one that runs out or loses its grant is ended by the health cron's
// pass, and a resource that cannot be rotated says so to the admins.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);
const tA = { id: `co-a-${suffix}`, slug: `co-a-${suffix}` };
const conn = `co-c-${suffix}`;
const site = `cos-${suffix}`;
const vncSite = `cov-${suffix}`;
const [ana, bob] = [`co-ana-${suffix}`, `co-bob-${suffix}`];
const DP_SECRET = `co-dp-${suffix}`;
const subtle = globalThis.crypto.subtle;
const target = { host: "10.0.0.7", port: 22, username: "alice" };
const vncTarget = { host: "10.0.0.8", port: 5900, username: "console" };

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

async function open(priv: CryptoKey, pubRaw: Uint8Array, sealed: string, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = Uint8Array.from(Buffer.from(sealed.slice(4), "base64"));
  const eph = await subtle.importKey("raw", raw.slice(0, 32), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, priv, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...raw.slice(0, 32), ...pubRaw]), info: new TextEncoder().encode("captivo-access vault v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(32, 44), additionalData: aad }, key, raw.slice(44)));
}

describe.skipIf(!OWNER_URL)("password check-out", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let seal: typeof import("@/lib/vault/seal");
  let co: typeof import("@/lib/vault/checkout");
  let pass: typeof import("@/lib/vault/rotation-pass");
  let fakeDataplane: Server;
  let conKey: { priv: CryptoKey; pubRaw: Uint8Array; pub: string };
  const account = { password: "first-pass" };

  const run = <T>(fn: () => Promise<T>) => withTenant(tA.id, fn);
  const user = async () => {
    const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    return { priv: kp.privateKey, pubRaw, pub: Buffer.from(pubRaw).toString("base64") };
  };
  const take = (who: string, k: { pub: string }, reason = "Console access during the outage", grantEnd: Date | null = null) =>
    run(() => co.startCheckout({ userId: who, userEmail: `${who}@a.test`, siteId: site, reason, publicKey: k.pub, grantEnd, ip: "10.1.1.1" }));
  const credRow = () => owner.$queryRawUnsafe<{ secret: string; rotateDueAt: Date | null }[]>(`SELECT secret, "rotateDueAt" FROM "VaultCredential" WHERE "siteId" = $1`, site).then((r) => r[0]);
  const lastCheckout = () => owner.$queryRawUnsafe<{ id: string; endedBy: string | null; endsAt: Date }[]>(`SELECT id, "endedBy", "endsAt" FROM "CredentialCheckout" WHERE "siteId" = $1 ORDER BY "startedAt" DESC LIMIT 1`, site).then((r) => r[0]);
  const notes = (type: string) => owner.$queryRawUnsafe<{ detail: string }[]>(`SELECT detail FROM "Notification" WHERE "tenantId" = $1 AND type = $2`, tA.id, type);

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    conKey = { priv: kp.privateKey, pubRaw, pub: Buffer.from(pubRaw).toString("base64") };
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Co A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.60.0',$3)`, conn, tA.id, conKey.pub);
    for (const u of [ana, bob]) await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,$3,$4,'VENDOR','ACTIVE')`, u, tA.id, `${u}@a.test`, u);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","passwordCheckout","checkoutMaxMinutes") VALUES($1,$2,$3,'Billing box','GATEWAY',true,60)`, site, tA.id, conn);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","passwordCheckout") VALUES($1,$2,$3,'Console','GATEWAY',true)`, vncSite, tA.id, conn);
    for (const [u, s] of [[ana, site], [bob, site], [ana, vncSite]]) await owner.$executeRawUnsafe(`INSERT INTO "AccessGrant"(id,"tenantId","userId","siteId") VALUES($1,$2,$3,$4)`, `cog-${u}-${s}`, tA.id, u, s);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_SECRET = DP_SECRET;
    process.env.VAULT_ENABLED = "true";
    process.env.ACCESS_DOMAIN = "example.test";

    fakeDataplane = createServer(async (rq, res) => {
      let raw = "";
      for await (const chunk of rq) raw += chunk;
      if (rq.headers["x-dataplane-secret"] !== DP_SECRET) return void res.writeHead(403).end();
      const send = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (rq.url === "/sessions") return send([]);
      if (rq.url !== "/vault-rotate") return void res.writeHead(404).end();
      const { request: r } = JSON.parse(raw) as { request: Record<string, string & string[]> };
      const t = { host: r.host, port: Number(r.port), username: r.username };
      const cur = await open(conKey.priv, conKey.pubRaw, r.current, seal.targetAAD(t));
      if (r.op === "reveal") return send({ seals: { [r.to[0]]: await seal.sealSecret(r.to[0], cur, t) } });
      if (r.op === "prepare") {
        const next = `rot-${crypto.randomUUID().slice(0, 12)}`;
        return send({ seals: Object.fromEntries(await Promise.all((r.to as unknown as string[]).map(async (to) => [to, await seal.sealSecret(to, next, t)] as const))) });
      }
      if (r.op === "apply") {
        const next = await open(conKey.priv, conKey.pubRaw, r.pending, seal.targetAAD(t));
        account.password = next;
        return send({ outcome: "rotated", sshHostKey: "SHA256:test" });
      }
      return send({ error: "unknown op" });
    });
    await new Promise<void>((r) => fakeDataplane.listen(0, "127.0.0.1", r));
    process.env.DATAPLANE_URL = `http://127.0.0.1:${(fakeDataplane.address() as AddressInfo).port}`;
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    seal = await import("@/lib/vault/seal");
    co = await import("@/lib/vault/checkout");
    pass = await import("@/lib/vault/rotation-pass");
    const s1 = await seal.sealSecret(conKey.pub, "first-pass", target);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","updatedAt") VALUES($1,$2,$3,'SSH',$4,$5,$6,$7,$8,now())`, `cov1-${suffix}`, tA.id, site, target.host, target.port, target.username, s1, conKey.pub);
    const s2 = await seal.sealSecret(conKey.pub, "vnc-pass", vncTarget);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","updatedAt") VALUES($1,$2,$3,'VNC',$4,$5,$6,$7,$8,now())`, `cov2-${suffix}`, tA.id, vncSite, vncTarget.host, vncTarget.port, vncTarget.username, s2, conKey.pub);
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    await new Promise((r) => fakeDataplane.close(r));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN"]) delete process.env[k];
  });

  it("asks for a reason and a key before it hands anything out", async () => {
    const k = await user();
    expect(await take(ana, k, "short")).toMatchObject({ ok: false, error: "reason_required" });
    expect(await run(() => co.startCheckout({ userId: ana, userEmail: "a", siteId: site, reason: "Console access during the outage", publicKey: "nope", grantEnd: null, ip: null }))).toMatchObject({ ok: false, error: "invalid_key" });
    expect(await take("someone-without-a-grant", k)).toMatchObject({ ok: false, status: 403 });
  });

  it("hands the password to one person, sealed to their browser key, and holds rotation", async () => {
    const k = await user();
    const r = await take(ana, k);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(await open(k.priv, k.pubRaw, r.sealed, seal.targetAAD(target))).toBe("first-pass");
    expect(r.willRotate).toBe(true);
    // At most the resource's 60 minutes.
    expect(r.endsAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 2000);
    expect((await credRow()).rotateDueAt!.getTime()).toBe(r.endsAt.getTime());
    // Someone else is told it is taken, and by whom.
    expect(await take(bob, await user())).toMatchObject({ ok: false, status: 409, error: "checked_out", by: ana });
    // Rotation does not touch it while it is out, even when asked to.
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "rotateDueAt" = now() - interval '1 second' WHERE "siteId" = $1`, site);
    const res = await pass.runRotationPass(tA.id, { siteId: site, force: true });
    expect(res.rotated).toBe(0);
    expect(res.skipped[0]?.reason).toMatch(/checked out/);
    expect(account.password).toBe("first-pass");
    expect((await run(() => co.activeCheckout(site)))?.userId).toBe(ana);
  });

  it("changes the password when it is returned, so what the person holds stops working", async () => {
    const mine = await lastCheckout();
    expect(await run(() => co.endCheckout(mine.id, "returned", { id: ana, email: "a" }))).toBe(true);
    expect(await run(() => co.endCheckout(mine.id, "returned", null))).toBe(false); // already over
    expect((await lastCheckout()).endedBy).toBe("returned");
    const res = await pass.runRotationPass(tA.id);
    expect(res.rotated).toBe(1);
    expect(account.password).not.toBe("first-pass");
    const audit = await owner.$queryRawUnsafe<{ action: string }[]>(`SELECT action FROM "AdminAuditEvent" WHERE "tenantId" = $1 AND "targetId" = $2 ORDER BY timestamp`, tA.id, site);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["credential.checkout", "credential.checkin", "resource.password_rotate"]));
    expect((await notes("credential_checkout")).length).toBe(1);
  });

  it("ends a check-out that ran out, and one whose grant went, in the health cron's pass", async () => {
    const k = await user();
    const r = await take(bob, k);
    if (!r.ok) throw new Error(JSON.stringify(r));
    await owner.$executeRawUnsafe(`UPDATE "CredentialCheckout" SET "endsAt" = now() - interval '1 minute' WHERE id = $1`, r.id);
    expect(await run(() => co.processCheckouts())).toBe(1);
    expect((await lastCheckout()).endedBy).toBe("expired");

    const r2 = await take(ana, await user());
    if (!r2.ok) throw new Error(JSON.stringify(r2));
    expect(await run(() => co.processCheckouts())).toBe(0); // still running, grant intact
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'REVOKED', "revokedAt" = now() WHERE "userId" = $1 AND "siteId" = $2`, ana, site);
    expect(await run(() => co.processCheckouts())).toBe(1);
    expect((await lastCheckout()).endedBy).toBe("revoked");
  });

  it("takes the end of the person's own grant when it comes first", async () => {
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET status = 'ACTIVE', "revokedAt" = NULL WHERE "userId" = $1 AND "siteId" = $2`, ana, site);
    const soon = new Date(Date.now() + 20 * 60_000);
    const r = await take(ana, await user(), "Console access during the outage", soon);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.endsAt.getTime()).toBe(soon.getTime());
    await run(() => co.endCheckout(r.id, "returned", null));
    expect(await take(ana, await user(), "Console access during the outage", new Date(Date.now() - 1000))).toMatchObject({ ok: false, error: "grant_ended" });
  });

  it("tells the admins when a password it cannot change was handed out", async () => {
    const k = await user();
    const r = await run(() => co.startCheckout({ userId: ana, userEmail: "ana@a.test", siteId: vncSite, reason: "Console access during the outage", publicKey: k.pub, grantEnd: null, ip: null }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.willRotate).toBe(false); // VNC passwords are not rotated
    expect(await open(k.priv, k.pubRaw, r.sealed, seal.targetAAD(vncTarget))).toBe("vnc-pass");
    await run(() => co.endCheckout(r.id, "returned", null));
    expect((await notes("checkout_not_rotated")).length).toBe(1);
  });

  it("refuses a resource that has it off, keeps it from a vault source and from a moderated resource", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "passwordCheckout" = false WHERE id = $1`, site);
    expect(await take(ana, await user())).toMatchObject({ ok: false, error: "checkout_off" });
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "passwordCheckout" = true, "requireModerator" = true WHERE id = $1`, site);
    expect(await take(ana, await user())).toMatchObject({ ok: false, error: "checkout_moderated" });
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "requireModerator" = false WHERE id = $1`, site);
    await owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "secretSource" = 'hashicorp' WHERE "siteId" = $1`, site);
    expect(await take(ana, await user())).toMatchObject({ ok: false, error: "checkout_vault" });
  });
});
