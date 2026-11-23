// Password rotation against a real Postgres with RLS, through a stand-in
// dataplane that does what connector/rotate.go does with the connectors' own
// keys and an in-memory target account: the prepared password is stored as
// pending BEFORE the target changes, a lost answer keeps both passwords and
// the next pass settles on the one the target took, a session holds it, an
// admin's re-entered password wins, too-old connectors are left alone, and
// "Reveal" hands a password only the requesting browser can open.
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
const tA = { id: `rot-a-${suffix}`, slug: `rot-a-${suffix}` };
const [c1, c2] = ["c1", "c2"].map((n) => `rot-${n}-${suffix}`);
const site = `rots-${suffix}`;
const DP_SECRET = `rot-dp-${suffix}`;
const subtle = globalThis.crypto.subtle;
const target = { host: "10.0.0.7", port: 22, username: "alice" };

// The console host the routes resolve the tenant from.
vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: `rot-admin-${suffix}`, email: "admin@a.test", role: "ADMIN" }) }));

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

async function open(k: Key, sealed: string, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = Uint8Array.from(Buffer.from(sealed.slice(4), "base64"));
  const eph = await subtle.importKey("raw", raw.slice(0, 32), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, k.priv, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...raw.slice(0, 32), ...k.pubRaw]), info: new TextEncoder().encode("captivo-access vault v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(32, 44), additionalData: aad }, key, raw.slice(44)));
}

describe.skipIf(!OWNER_URL)("password rotation", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let seal: typeof import("@/lib/vault/seal");
  let pass: typeof import("@/lib/vault/rotation-pass");
  let rotationRoute: typeof import("@/app/api/admin/sites/[id]/rotation/route");
  let fakeDataplane: Server;
  const keys: Record<string, Key> = {};
  // The target: the password it takes now, and what the fake connector does.
  const account = { password: "first-pass" };
  const ops: { op: string; pendingStoredAtApply?: boolean }[] = [];
  let loseNextApplyAnswer = false;
  let liveSites: string[] = [];

  const cred = () => owner.$queryRawUnsafe<{ secret: string; sealedTo: string; extraSeals: Record<string, string> | null; pendingSeals: unknown; rotationState: string | null; rotationDetail: string | null; rotateDueAt: Date | null; rotatedAt: Date | null }[]>(
    `SELECT secret, "sealedTo", "extraSeals", "pendingSeals", "rotationState", "rotationDetail", "rotateDueAt", "rotatedAt" FROM "VaultCredential" WHERE "siteId" = $1`, site).then((r) => r[0]);
  const savedPasswordFor = async (n: string) => {
    const c = await cred();
    const s = c.sealedTo === keys[n].pub ? c.secret : c.extraSeals?.[keys[n].pub];
    return open(keys[n], s!, seal.targetAAD(target));
  };
  const makeDue = () => owner.$executeRawUnsafe(`UPDATE "VaultCredential" SET "rotateDueAt" = now() - interval '1 second' WHERE "siteId" = $1`, site);
  const req = (method: string, body?: unknown) => new Request(`http://x/api/admin/sites/${site}/rotation`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }) as unknown as NextRequest;
  const ctx = { params: Promise.resolve({ id: site }) };

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    for (const n of [c1, c2]) keys[n] = await connectorKey();
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Rot A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.45.0',$3)`, c1, tA.id, keys[c1].pub);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'two',$1,'ONLINE','2.44.0',$3)`, c2, tA.id, keys[c2].pub);
    await owner.$executeRawUnsafe(`INSERT INTO "ConnectorGroup"(id,"tenantId",name) VALUES($1,$2,'DC')`, `rotg-${suffix}`, tA.id);
    for (const n of [c1, c2]) await owner.$executeRawUnsafe(`INSERT INTO "ConnectorGroupMember"("tenantId","groupId","connectorId") VALUES($1,$2,$3)`, tA.id, `rotg-${suffix}`, n);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId","connectorGroupId",name,"accessMode") VALUES($1,$2,$3,$4,'Billing box','GATEWAY')`, site, tA.id, c1, `rotg-${suffix}`);
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
      if (rq.url === "/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(liveSites.map((siteId) => ({ siteId }))));
      if (rq.url !== "/vault-rotate") return void res.writeHead(404).end();
      const { connectorId, request: r } = JSON.parse(raw) as { connectorId: string; request: Record<string, string & string[]> };
      const k = keys[connectorId];
      const t = { host: r.host, port: Number(r.port), username: r.username };
      const send = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      let cur: string;
      try {
        cur = await open(k, r.current, seal.targetAAD(t));
      } catch {
        return send({ error: "the saved password does not open here" });
      }
      if (r.op === "prepare") {
        ops.push({ op: "prepare" });
        const next = `rot-${crypto.randomUUID().slice(0, 12)}`;
        return send({ seals: Object.fromEntries(await Promise.all((r.to as unknown as string[]).map(async (to) => [to, await seal.sealSecret(to, next, t)] as const))) });
      }
      if (r.op === "reveal") return send({ seals: { [r.to[0]]: await seal.sealSecret(r.to[0], cur, t) } });
      const next = await open(k, r.pending, seal.targetAAD(t));
      if (r.op === "apply") {
        const c = await cred();
        ops.push({ op: "apply", pendingStoredAtApply: c.pendingSeals != null });
        if (account.password === next) return send({ outcome: "already" });
        if (account.password !== cur) return send({ outcome: "failed", outOfSync: true, detail: "the saved password no longer signs in and there is no reconcile account" });
        account.password = next;
        if (loseNextApplyAnswer) {
          loseNextApplyAnswer = false;
          return send({ error: "stream reset" }, 502);
        }
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
    pass = await import("@/lib/vault/rotation-pass");
    rotationRoute = await import("@/app/api/admin/sites/[id]/rotation/route");

    // The saved password, sealed in the browser to both members.
    const s1 = await seal.sealSecret(keys[c1].pub, "first-pass", target);
    const s2 = await seal.sealSecret(keys[c2].pub, "first-pass", target);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","extraSeals","updatedAt") VALUES($1,$2,$3,'SSH',$4,$5,$6,$7,$8,$9::jsonb,now())`,
      `rotv-${suffix}`, tA.id, site, target.host, target.port, target.username, s1, keys[c1].pub, JSON.stringify({ [keys[c2].pub]: s2 }));
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    await new Promise((r) => fakeDataplane.close(r));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN"]) delete process.env[k];
  });

  it("turns on after-session rotation and makes it due a minute after a session closes", async () => {
    const res = await rotationRoute.PUT(req("PUT", { afterSession: true, everyDays: null, verifyDaily: false }), ctx);
    expect(res.status).toBe(200);
    const n = await withTenant(tA.id, () => pass.noteSessionsClosed([site]));
    expect(n).toBe(1);
    const due = (await cred()).rotateDueAt!.getTime();
    expect(due - Date.now()).toBeGreaterThan(50_000);
    expect(due - Date.now()).toBeLessThan(65_000);
  });

  it("does nothing while a session is open on it", async () => {
    await makeDue();
    liveSites = [site];
    await pass.runRotationPass(tA.id);
    liveSites = [];
    expect(ops).toEqual([]);
    expect(account.password).toBe("first-pass");
  });

  it("stores the prepared password before the target changes, then makes it the saved one for every member", async () => {
    await pass.runRotationPass(tA.id);
    expect(ops.map((o) => o.op)).toEqual(["prepare", "apply"]);
    expect(ops[1].pendingStoredAtApply).toBe(true);
    expect(account.password).not.toBe("first-pass");
    // Both members open the new one, though only c1 (2.45) can rotate.
    expect(await savedPasswordFor(c1)).toBe(account.password);
    expect(await savedPasswordFor(c2)).toBe(account.password);
    const c = await cred();
    expect(c.pendingSeals).toBeNull();
    expect(c.rotationState).toBe("ok");
    expect(c.rotateDueAt).toBeNull(); // no schedule: the next session sets it
    const audit = await owner.$queryRawUnsafe<{ summary: string }[]>(`SELECT summary FROM "AdminAuditEvent" WHERE "tenantId" = $1 AND action = 'resource.password_rotate'`, tA.id);
    expect(audit[0].summary).toContain("alice@10.0.0.7");
  });

  it("keeps both passwords when the answer is lost, and the next pass settles on the one the target took", async () => {
    const before = account.password;
    ops.length = 0;
    loseNextApplyAnswer = true;
    await makeDue();
    await pass.runRotationPass(tA.id);
    expect(account.password).not.toBe(before); // the target changed...
    expect(await savedPasswordFor(c1)).toBe(before); // ...but the saved one did not, yet
    const mid = await cred();
    expect(mid.pendingSeals).not.toBeNull();
    expect(mid.rotationState).toBe("unknown");

    await makeDue();
    await pass.runRotationPass(tA.id);
    expect(ops.map((o) => o.op)).toEqual(["prepare", "apply", "apply"]); // no second prepare
    expect(await savedPasswordFor(c1)).toBe(account.password);
    expect(await savedPasswordFor(c2)).toBe(account.password);
    expect((await cred()).rotationState).toBe("ok");
  });

  it("reports a password changed outside Captivo and keeps the saved one", async () => {
    const saved = account.password;
    account.password = "changed-by-someone";
    await makeDue();
    await pass.runRotationPass(tA.id);
    const c = await cred();
    expect(c.rotationState).toBe("out_of_sync");
    expect(await savedPasswordFor(c1)).toBe(saved);
    const notes = await owner.$queryRawUnsafe<{ type: string }[]>(`SELECT type FROM "Notification" WHERE "tenantId" = $1`, tA.id);
    expect(notes.map((x) => x.type)).toContain("out_of_sync");
    account.password = saved;
  });

  it("leaves it alone when no connector is new enough", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.44.0' WHERE id = $1`, c1);
    ops.length = 0;
    await makeDue();
    await pass.runRotationPass(tA.id);
    expect(ops).toEqual([]);
    await owner.$executeRawUnsafe(`UPDATE "Connector" SET version = '2.45.0' WHERE id = $1`, c1);
  });

  it("reveals the password sealed to the requesting browser only, with the reason in the audit log", async () => {
    const own = await seal.revealKeyPair();
    const short = await rotationRoute.POST(req("POST", { action: "reveal", reason: "short", publicKey: own.publicKey }), ctx);
    expect(short.status).toBe(400);
    const res = await rotationRoute.POST(req("POST", { action: "reveal", reason: "Console access during the outage", publicKey: own.publicKey }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sealed: string; target: typeof target; rotatesAt: string | null };
    expect(await seal.openSealedSecret(own, body.sealed, body.target)).toBe(await savedPasswordFor(c1));
    expect(body.rotatesAt).not.toBeNull();
    const audit = await owner.$queryRawUnsafe<{ summary: string }[]>(`SELECT summary FROM "AdminAuditEvent" WHERE "tenantId" = $1 AND action = 'resource.password_reveal'`, tA.id);
    expect(audit[0].summary).toContain("Console access during the outage");
  });

  it("refuses rotation on a resource that offers a native client", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "nativeSsh" = true WHERE id = $1`, site);
    const res = await rotationRoute.PUT(req("PUT", { afterSession: true, everyDays: null, verifyDaily: false }), ctx);
    expect(res.status).toBe(400);
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "nativeSsh" = false WHERE id = $1`, site);
  });

  it("allows rotation with native SSH on a recorded resource, as Captivo signs in", async () => {
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "nativeSsh" = true, "recordSessions" = true WHERE id = $1`, site);
    const on = await rotationRoute.PUT(req("PUT", { afterSession: true, everyDays: null, verifyDaily: false }), ctx);
    expect(on.status).toBe(200);
    const off = await rotationRoute.PUT(req("PUT", { afterSession: false, everyDays: null, verifyDaily: false }), ctx);
    expect(off.status).toBe(200);
    await owner.$executeRawUnsafe(`UPDATE "Site" SET "nativeSsh" = false, "recordSessions" = false WHERE id = $1`, site);
  });
});
