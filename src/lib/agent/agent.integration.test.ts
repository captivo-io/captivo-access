// The agent API against a real Postgres with RLS: an admin makes a token, the
// agent asks for access with a reason, a person approves (or the token does,
// within its limits), the agent gets an SSH command, and revoking the token
// ends all of it.
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
const tA = { id: `ag-a-${suffix}`, slug: `ag-a-${suffix}` };
const conn = `ag-c-${suffix}`;
const [sshSite, rdpSite] = [`ags-ssh-${suffix}`, `ags-rdp-${suffix}`];
const admin = `ag-adm-${suffix}`;
const DP_SECRET = `ag-dp-${suffix}`;
const target = { host: "10.0.0.7", port: 22, username: "deploy" };
const H = "http://x";

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: async () => ({ id: `ag-adm-${process.env.AG_SUFFIX}`, email: "admin@a.test", role: "ADMIN" }) }));

function toAppUrl(owner: string): string {
  const u = new URL(owner);
  u.username = "app";
  u.password = "rls_test_pw";
  return u.toString();
}

describe.skipIf(!OWNER_URL)("agent API", () => {
  let owner: PrismaClient;
  let agents: typeof import("@/app/api/admin/agents/route");
  let agentById: typeof import("@/app/api/admin/agents/[id]/route");
  let me: typeof import("@/app/api/agent/v1/me/route");
  let access: typeof import("@/app/api/agent/v1/access/route");
  let accessId: typeof import("@/app/api/agent/v1/access/[id]/route");
  let connect: typeof import("@/app/api/agent/v1/connect/[siteId]/route");
  let fakeDataplane: Server;
  let token = "";
  let tokenId = "";
  let autoToken = "";

  const call = (h: (r: NextRequest, c?: never) => Promise<Response>, method: string, url: string, tk: string | null, body?: unknown, ctx?: unknown) =>
    (h as unknown as (r: Request, c: unknown) => Promise<Response>)(new Request(`${H}${url}`, { method, headers: { "content-type": "application/json", ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), ctx);
  const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const grantOf = (id: string) => owner.$queryRawUnsafe<{ status: string; approvedAt: Date | null; endsAt: Date | null; revokeReason: string | null }[]>(`SELECT status, "approvedAt", "endsAt", "revokeReason" FROM "AccessGrant" WHERE id = $1`, id).then((r) => r[0]);

  beforeAll(async () => {
    process.env.AG_SUFFIX = suffix;
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
      for await (const _ of rq) void _;
      if (rq.headers["x-dataplane-secret"] !== DP_SECRET) return void res.writeHead(403).end();
      if (rq.url === "/ssh-ticket") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, fingerprint: "SHA256:jump" }));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => fakeDataplane.listen(0, "127.0.0.1", r));
    process.env.DATAPLANE_URL = `http://127.0.0.1:${(fakeDataplane.address() as AddressInfo).port}`;

    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Ag A','ACTIVE')`, tA.id, tA.slug);
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status,version,"vaultPublicKey") VALUES($1,$2,'one',$1,'ONLINE','2.71.0',$3)`, conn, tA.id, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,'admin@a.test','Admin','ADMIN','ACTIVE')`, admin, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","nativeSsh","recordSessions") VALUES($1,$2,$3,'Build box','GATEWAY',true,true)`, sshSite, tA.id, conn);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode") VALUES($1,$2,$3,'Desktop','GATEWAY')`, rdpSite, tA.id, conn);
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    const { sealSecret } = await import("@/lib/vault/seal");
    const s = await sealSecret(pub, "deploy-pass", target);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","updatedAt") VALUES($1,$2,$3,'SSH',$4,$5,$6,$7,$8,now())`, `agv1-${suffix}`, tA.id, sshSite, target.host, target.port, target.username, s, pub);
    await owner.$executeRawUnsafe(`INSERT INTO "VaultCredential"(id,"tenantId","siteId",protocol,"targetHost","targetPort",username,secret,"sealedTo","updatedAt") VALUES($1,$2,$3,'RDP',$4,3389,'Administrator',$5,$6,now())`, `agv2-${suffix}`, tA.id, rdpSite, target.host, s, pub);
    agents = await import("@/app/api/admin/agents/route");
    agentById = await import("@/app/api/admin/agents/[id]/route");
    me = await import("@/app/api/agent/v1/me/route");
    access = await import("@/app/api/agent/v1/access/route");
    accessId = await import("@/app/api/agent/v1/access/[id]/route");
    connect = await import("@/app/api/agent/v1/connect/[siteId]/route");
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, tA.id);
    await owner.$disconnect();
    await new Promise((r) => fakeDataplane.close(r));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_SECRET", "VAULT_ENABLED", "DATAPLANE_URL", "ACCESS_DOMAIN", "AG_SUFFIX"]) delete process.env[k];
  });

  it("makes a token only for resources an agent can connect to, shown once", async () => {
    const bad = await json(await call(agents.POST as never, "POST", "/api/admin/agents", null, { name: "pipeline", siteIds: [sshSite, rdpSite] }));
    expect(bad).toMatchObject({ status: 400, body: { error: "site_not_supported" } });
    const ok = await json(await call(agents.POST as never, "POST", "/api/admin/agents", null, { name: "pipeline", siteIds: [sshSite], maxMinutes: 30 }));
    expect(ok.status).toBe(201);
    token = ok.body.token;
    tokenId = ok.body.id;
    expect(token).toMatch(/^cat_/);
    const list = await json(await call(agents.GET as never, "GET", "/api/admin/agents", null));
    expect(JSON.stringify(list.body)).not.toContain(token);
    // Only the hash is kept.
    const row = (await owner.$queryRawUnsafe<{ tokenHash: string }[]>(`SELECT "tokenHash" FROM "ApiToken" WHERE id = $1`, tokenId))[0];
    expect(row.tokenHash).not.toBe(token);
  });

  it("answers only a live token", async () => {
    expect((await call(me.GET as never, "GET", "/api/agent/v1/me", null)).status).toBe(401);
    expect((await call(me.GET as never, "GET", "/api/agent/v1/me", "cat_nope")).status).toBe(401);
    const r = await json(await call(me.GET as never, "GET", "/api/agent/v1/me", token));
    expect(r.status).toBe(200);
    expect(r.body.agent).toMatchObject({ name: "pipeline", maxMinutes: 30, autoApprove: false });
    expect(r.body.resources).toEqual([{ id: sshSite, name: "Build box", kind: "ssh", access: null }]);
  });

  it("asks for access with a reason, held to the token's limits, and waits for a person", async () => {
    expect((await call(access.POST as never, "POST", "/api/agent/v1/access", token, { siteId: rdpSite, reason: "Roll back release 4.2" })).status).toBe(403);
    expect((await json(await call(access.POST as never, "POST", "/api/agent/v1/access", token, { siteId: sshSite, reason: "short" }))).body.error).toBe("reason_required");
    const r = await json(await call(access.POST as never, "POST", "/api/agent/v1/access", token, { siteId: sshSite, minutes: 600, reason: "Roll back release 4.2 (INC-1042)" }));
    expect(r).toMatchObject({ status: 201, body: { status: "pending" } });
    const mins = (new Date(r.body.endsAt).getTime() - new Date(r.body.startsAt).getTime()) / 60_000;
    expect(Math.round(mins)).toBe(30);
    const dup = await json(await call(access.POST as never, "POST", "/api/agent/v1/access", token, { siteId: sshSite, reason: "Roll back release 4.2 again" }));
    expect(dup).toMatchObject({ status: 409, body: { error: "already_requested", id: r.body.id, status: "pending" } });
    const g = await grantOf(r.body.id);
    expect(g.approvedAt).toBeNull();
    const st = await json(await call(accessId.GET as never, "GET", `/api/agent/v1/access/${r.body.id}`, token, undefined, { params: Promise.resolve({ id: r.body.id }) }));
    expect(st.body.status).toBe("pending");
    // No command until it is approved.
    const c = await json(await call(connect.POST as never, "POST", `/api/agent/v1/connect/${sshSite}`, token, undefined, { params: Promise.resolve({ siteId: sshSite }) }));
    expect(c).toMatchObject({ status: 403, body: { error: "no_active_access" } });
    // A person approves.
    await owner.$executeRawUnsafe(`UPDATE "AccessGrant" SET "approvedAt" = now() WHERE id = $1`, r.body.id);
    const st2 = await json(await call(accessId.GET as never, "GET", `/api/agent/v1/access/${r.body.id}`, token, undefined, { params: Promise.resolve({ id: r.body.id }) }));
    expect(st2.body.status).toBe("active");
    const ok = await json(await call(connect.POST as never, "POST", `/api/agent/v1/connect/${sshSite}`, token, undefined, { params: Promise.resolve({ siteId: sshSite }) }));
    expect(ok.status).toBe(200);
    expect(ok.body.recorded).toBe(true);
    expect(ok.body.command).toMatch(/^ssh -J [^@]+@[^ ]+ -o HostKeyAlias=captivo-recorded\.[^ ]+ deploy@10\.0\.0\.7$/);
    // Another agent's request is not visible to it.
    expect((await call(accessId.GET as never, "GET", `/api/agent/v1/access/${r.body.id}`, "cat_other", undefined, { params: Promise.resolve({ id: r.body.id }) })).status).toBe(401);
  });

  it("a token made to approve its own requests is approved at once, and the audit log says so", async () => {
    const made = await json(await call(agents.POST as never, "POST", "/api/admin/agents", null, { name: "nightly", siteIds: [sshSite], maxMinutes: 15, autoApprove: true }));
    autoToken = made.body.token;
    const r = await json(await call(access.POST as never, "POST", "/api/agent/v1/access", autoToken, { siteId: sshSite, minutes: 15, reason: "Nightly log collection" }));
    expect(r).toMatchObject({ status: 201, body: { status: "approved", via: "token" } });
    expect((await grantOf(r.body.id)).approvedAt).not.toBeNull();
    const audit = await owner.$queryRawUnsafe<{ summary: string }[]>(`SELECT summary FROM "AdminAuditEvent" WHERE "tenantId" = $1 AND action = 'grant.auto_approved'`, tA.id);
    expect(audit.some((a) => a.summary.includes("nightly") && a.summary.includes("without a person's approval"))).toBe(true);
  });

  it("stops working when it is revoked, and takes its access with it", async () => {
    const r = await json(await call(agentById.DELETE as never, "DELETE", `/api/admin/agents/${tokenId}`, null, undefined, { params: Promise.resolve({ id: tokenId }) }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, ended: 1 } });
    expect((await call(me.GET as never, "GET", "/api/agent/v1/me", token)).status).toBe(401);
    const gone = await owner.$queryRawUnsafe<{ status: string; revokeReason: string }[]>(`SELECT g.status, g."revokeReason" FROM "AccessGrant" g JOIN "ApiToken" t ON t."userId" = g."userId" WHERE t.id = $1`, tokenId);
    expect(gone.every((g) => g.status === "REVOKED" && g.revokeReason!.includes("revoked"))).toBe(true);
    // The other agent is untouched.
    expect((await call(me.GET as never, "GET", "/api/agent/v1/me", autoToken)).status).toBe(200);
  });
});
