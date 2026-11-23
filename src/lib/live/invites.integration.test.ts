// Session invites against a real Postgres with RLS and a data plane stand-in
// on loopback: an invite belongs to one workspace, its link works once, the
// guest's pass answers only for its own session, and withdrawing it closes the
// guest's view at the data plane.
//
// Requires TEST_DATABASE_URL (owner connection, schema pushed, bootstrap.sql
// applied with app_password=rls_test_pw); SKIPPED otherwise. Run it in its own
// vitest process (it mutates process env and the db module cache).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const sfx = crypto.randomUUID().slice(0, 8);
const tA = { id: `si-a-${sfx}`, slug: `si-a-${sfx}` };
const tB = { id: `si-b-${sfx}`, slug: `si-b-${sfx}` };
const u = { admin: `si-adm-${sfx}`, vendor: `si-v-${sfx}` };
const site = `si-site-${sfx}`;
const sess = { rdp: `rdp${sfx}`, iso: `iso${sfx}` };

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));

const kicked: string[] = [];
let server: Server;

function toAppUrl(owner: string): string {
  const x = new URL(owner);
  x.username = "app";
  x.password = "rls_test_pw";
  return x.toString();
}

describe.skipIf(!OWNER_URL)("session invites", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let inv: typeof import("@/lib/live/invites");
  let tok: typeof import("@/lib/live/invite-token");
  const actor = { id: u.admin, email: `${u.admin}@corp.test` };
  const create = (over: Partial<Parameters<typeof inv.createSessionInvite>[0]> = {}, tenant = tA.id) =>
    withTenant(tenant, () => inv.createSessionInvite({ sessionId: sess.rdp, email: "Guest@Partner.test", canControl: true, duration: "1h", actor, baseUrl: "https://x.test", ...over }));

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/sessions") {
          const at = new Date().toISOString();
          return res.end(JSON.stringify([
            { sessionId: sess.rdp, siteId: site, userId: u.vendor, kind: "gateway", protocol: "rdp", host: "10.0.0.5", startedAt: at, viewerCount: 0, controlOwner: "" },
            { sessionId: sess.iso, siteId: site, userId: u.vendor, kind: "isolated", protocol: "isolated", host: "web", startedAt: at, viewerCount: 0, controlOwner: "" },
          ]));
        }
        if (req.url === "/sessions/kick-viewer") kicked.push(JSON.parse(body).viewerId);
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Si','ACTIVE')`, t.id, t.slug);
    for (const [id, role] of [[u.admin, "ADMIN"], [u.vendor, "VENDOR"]]) {
      await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,$3,$1,$4,'ACTIVE')`, id, tA.id, `${id}@corp.test`, role);
    }
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status) VALUES($1,$2,'c',$1,'ONLINE')`, `si-c-${sfx}`, tA.id);
    await owner.$executeRawUnsafe(`INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode") VALUES($1,$2,$3,'File server','TRANSPARENT')`, site, tA.id, `si-c-${sfx}`);
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformSettings"("tenantId","sessionInvitesEnabled","updatedAt") VALUES($1,false,now())`, tB.id);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.DATAPLANE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.CAPTIVO_DEPLOYMENT = "saas";
    process.env.CAPTIVO_ID_ISSUER = "https://id.example.test";
    process.env.CAPTIVO_ID_CLIENT_ID = "access";
    process.env.CAPTIVO_ID_CLIENT_SECRET = "s";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    inv = await import("@/lib/live/invites");
    tok = await import("@/lib/live/invite-token");
  });

  afterAll(async () => {
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, t.id);
    await owner.$disconnect();
    await new Promise<void>((r) => server.close(() => r()));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "DATAPLANE_URL", "CAPTIVO_DEPLOYMENT", "CAPTIVO_ID_ISSUER", "CAPTIVO_ID_CLIENT_ID", "CAPTIVO_ID_CLIENT_SECRET"]) delete process.env[k];
  });

  it("refuses what it can't stand behind", async () => {
    expect(await create({ email: "not-an-address" })).toEqual({ ok: false, error: "bad_email" });
    expect(await create({ sessionId: sess.iso })).toEqual({ ok: false, error: "not_invitable" });
    expect(await create({ sessionId: "nope" })).toEqual({ ok: false, error: "not_found" });
    // Another workspace can't see this session at all, and B has invites off.
    expect(await create({}, tB.id)).toEqual({ ok: false, error: "disabled" });
  });

  it("issues a one-time link, a pass for one session, and keeps both to their workspace", async () => {
    const r = await create();
    if (!r.ok) throw new Error(r.error);
    expect(r.invite).toMatchObject({ email: "guest@partner.test", canControl: true, status: "waiting" });
    expect(r.emailed).toBe(false);
    const token = r.link.split("/join/")[1];
    const stored = await owner.$queryRawUnsafe<{ linkHash: string }[]>(`SELECT "linkHash" FROM "SessionInvite" WHERE id = $1`, r.invite.id);
    expect(stored[0].linkHash).not.toContain(tok.parseLinkToken(token)!.secret);

    expect(await withTenant(tB.id, () => inv.openLink(token))).toEqual({ ok: false, problem: "invalid" });
    expect(await withTenant(tB.id, () => inv.listSessionInvites(sess.rdp))).toEqual([]);
    const opened = await withTenant(tA.id, () => inv.openLink(token));
    expect(opened).toMatchObject({ ok: true, link: { siteName: "File server", userLabel: u.vendor } });
    expect(await withTenant(tA.id, () => inv.openLink(`${r.invite.id}.${tok.newSecret()}`))).toEqual({ ok: false, problem: "invalid" });

    const secret = tok.newSecret();
    expect(await withTenant(tA.id, () => inv.consumeLink(r.invite.id, { name: "Ayşe Yılmaz", subject: "sub-1" }, secret))).toBe(true);
    expect(await withTenant(tA.id, () => inv.consumeLink(r.invite.id, { name: "Someone", subject: "sub-2" }, tok.newSecret()))).toBe(false);
    expect(await withTenant(tA.id, () => inv.openLink(token))).toEqual({ ok: false, problem: "used" });

    const pass = tok.guestPass(tA.id, r.invite.id, secret);
    expect(await withTenant(tA.id, () => inv.guestFromPass(pass))).toMatchObject({ guestName: "Ayşe Yılmaz", sessionId: sess.rdp, canControl: true });
    expect(await withTenant(tA.id, () => inv.guestFromPass(tok.guestPass(tA.id, r.invite.id, tok.newSecret())))).toBeNull();
    expect(await withTenant(tB.id, () => inv.guestFromPass(tok.guestPass(tB.id, r.invite.id, secret)))).toBeNull();
    expect(await withTenant(tA.id, () => inv.guestAuthz(pass, sess.iso, site))).toEqual({ allow: false });
    expect(await withTenant(tA.id, () => inv.guestAuthz(pass, sess.rdp, "other-site"))).toEqual({ allow: false });
    const ok = await withTenant(tA.id, () => inv.guestAuthz(pass, sess.rdp, site));
    expect(ok).toMatchObject({ allow: true, viewerId: `guest:${r.invite.id}`, name: "Ayşe Yılmaz" });

    const rec = await withTenant(tA.id, () => inv.guestsOfRecording({ siteId: site, userId: u.vendor, startedAt: new Date(Date.now() - 60_000), endedAt: new Date() }));
    expect(rec).toEqual([expect.objectContaining({ name: "Ayşe Yılmaz", email: "guest@partner.test", canControl: true, invitedBy: actor.email })]);

    // Withdrawn: the pass stops answering and the data plane is told to close the view.
    expect(await withTenant(tA.id, () => inv.revokeSessionInvite(sess.rdp, r.invite.id, actor))).toBe(true);
    expect(kicked).toContain(`guest:${r.invite.id}`);
    expect(await withTenant(tA.id, () => inv.guestFromPass(pass))).toBeNull();
    expect((await withTenant(tA.id, () => inv.listSessionInvites(sess.rdp)))[0].status).toBe("removed");
    const audit = await owner.$queryRawUnsafe<{ action: string }[]>(`SELECT action FROM "AdminAuditEvent" WHERE "tenantId" = $1 ORDER BY seq`, tA.id);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["session_invite.create", "session_invite.revoke"]));
  });

  it("ends a pass with its invite's time, and caps open invites per session", async () => {
    const r = await create({ duration: "15m", canControl: false });
    if (!r.ok) throw new Error(r.error);
    const secret = tok.newSecret();
    await withTenant(tA.id, () => inv.consumeLink(r.invite.id, { name: "Ali", subject: "s" }, secret));
    await owner.$executeRawUnsafe(`UPDATE "SessionInvite" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, r.invite.id);
    expect(await withTenant(tA.id, () => inv.guestFromPass(tok.guestPass(tA.id, r.invite.id, secret)))).toBeNull();

    for (let i = 0; i < tok.MAX_GUESTS_PER_SESSION; i++) expect((await create({ email: `g${i}@p.test` })).ok).toBe(true);
    expect(await create({ email: "one-more@p.test" })).toEqual({ ok: false, error: "too_many" });
  });
});
