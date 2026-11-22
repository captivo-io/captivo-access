// Ticketing against a real Postgres with RLS and a ServiceNow stand-in on
// loopback: the ticket system and its notes belong to one tenant, a resource
// that needs a ticket refuses a request without a usable one, an approved
// ticket approves on a resource that takes it as approval, and the recheck
// ends access when the ticket closes, opens a waiting request when the ticket
// is approved, and moves an end to the ticket's window. Session events queue
// work notes that reach the ticket.
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
const tA = { id: `tk-a-${sfx}`, slug: `tk-a-${sfx}` };
const tB = { id: `tk-b-${sfx}`, slug: `tk-b-${sfx}` };
const u = { admin: `tk-adm-${sfx}`, v1: `tk-v1-${sfx}`, v2: `tk-v2-${sfx}` };
const site = { req: `tk-req-${sfx}`, itsm: `tk-itsm-${sfx}`, off: `tk-off-${sfx}` };
const email = (id: string) => `${id}@vendor.test`;

vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-host", `${tA.slug}.example.test`]]) as unknown as Headers }));
// The stand-in listens on loopback, which Cloud's guard refuses by design.
vi.mock("@/lib/net/guarded-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/net/guarded-fetch")>()),
  tenantFetch: (url: string, init: { timeoutMs: number } & RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs) }),
}));

type Ticket = { state: string; approval: string; start?: string; end?: string; assignee: string };
const tickets = new Map<string, Ticket>();
const notes: { sysId: string; text: string }[] = [];
let server: Server;
let base = "";

function toAppUrl(owner: string): string {
  const x = new URL(owner);
  x.username = "app";
  x.password = "rls_test_pw";
  return x.toString();
}

describe.skipIf(!OWNER_URL)("ticketing", () => {
  let owner: PrismaClient;
  let withTenant: <T>(t: string, fn: () => Promise<T>) => Promise<T>;
  let sys: typeof import("@/lib/ticketing/system");
  let recheck: typeof import("@/lib/ticketing/recheck");
  let noteMod: typeof import("@/lib/ticketing/notes");
  let grants: typeof import("@/lib/access/grants");
  const grant = async (id: string) => (await owner.$queryRawUnsafe<{ status: string; revokeReason: string | null; approvedAt: Date | null; endsAt: Date | null; ticketVerified: boolean; ticket: Record<string, unknown> }[]>(
    `SELECT status, "revokeReason", "approvedAt", "endsAt", "ticketVerified", ticket FROM "AccessGrant" WHERE id = $1`, id))[0];
  const sitesOf = (ids: string[]) => owner.$queryRawUnsafe<{ id: string; name: string; ticketMode: string | null }[]>(`SELECT id, name, "ticketMode" FROM "Site" WHERE id = ANY($1)`, ids);
  const gateFor = (siteIds: string[], ref: string | undefined, who = u.v1, startsAt: Date | null = new Date(), endsAt: Date | null = new Date(Date.now() + 86_400_000)) =>
    withTenant(tA.id, async () => sys.gateTicket({ ref, sites: await sitesOf(siteIds), who: { email: email(who), name: who }, startsAt, endsAt, workspace: tA.slug }));

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
        const url = new URL(req.url!, "http://x");
        const m = url.pathname.match(/^\/api\/now\/table\/(change_request|incident)(?:\/(.+))?$/);
        if (!m) return send(404, {});
        if (req.method === "PATCH") { notes.push({ sysId: m[2], text: JSON.parse(body).work_notes }); return send(200, { result: {} }); }
        const num = (url.searchParams.get("sysparm_query") ?? "").replace("number=", "");
        const t = m[1] === "change_request" ? tickets.get(num) : undefined;
        if (!t) return send(200, { result: [] });
        const v = (x: string | undefined) => ({ value: x ?? "", display_value: x ?? "" });
        send(200, { result: [{ sys_id: v(`sys-${num}`), number: v(num), short_description: v(`Work for ${num}`), state: v(t.state), approval: v(t.approval), start_date: v(t.start), end_date: v(t.end), "assigned_to.email": v(t.assignee) }] });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES($1,$2,'Tk','ACTIVE')`, t.id, t.slug);
    for (const [id, role] of [[u.admin, "ADMIN"], [u.v1, "VENDOR"], [u.v2, "VENDOR"]]) {
      await owner.$executeRawUnsafe(`INSERT INTO "User"(id,"tenantId",email,name,role,status) VALUES($1,$2,$3,$1,$4,'ACTIVE')`, id, tA.id, email(id), role);
    }
    await owner.$executeRawUnsafe(`INSERT INTO "Connector"(id,"tenantId",name,"tokenHash",status) VALUES($1,$2,'c',$1,'ONLINE')`, `tk-c-${sfx}`, tA.id);
    await owner.$executeRawUnsafe(
      `INSERT INTO "Site"(id,"tenantId","connectorId",name,"accessMode","ticketMode") VALUES($1,$4,$5,'Billing','TRANSPARENT','required'),($2,$4,$5,'CRM','TRANSPARENT','itsm'),($3,$4,$5,'Wiki','TRANSPARENT',NULL)`,
      site.req, site.itsm, site.off, tA.id, `tk-c-${sfx}`);
    process.env.MULTI_TENANT = "on";
    process.env.APP_DATABASE_URL = toAppUrl(OWNER_URL!);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.ACCESS_DOMAIN = "example.test";
    delete (globalThis as { prismaBase?: unknown }).prismaBase;
    vi.resetModules();
    ({ withTenant } = await import("@/lib/tenant/scope"));
    sys = await import("@/lib/ticketing/system");
    recheck = await import("@/lib/ticketing/recheck");
    noteMod = await import("@/lib/ticketing/notes");
    grants = await import("@/lib/access/grants");
    const { encrypt } = await import("@/lib/crypto");
    const { db } = await import("@/lib/db");
    await withTenant(tA.id, () => db.ticketSystem.create({ data: { kind: "servicenow", baseUrl: base, username: "svc", secret: encrypt("pw"), defaultMode: "off", matchAssignee: true } }));
  });

  afterAll(async () => {
    for (const t of [tA, tB]) await owner.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, t.id);
    await owner.$disconnect();
    await new Promise<void>((r) => server.close(() => r()));
    for (const k of ["MULTI_TENANT", "APP_DATABASE_URL", "ENCRYPTION_KEY", "ACCESS_DOMAIN"]) delete process.env[k];
  });

  it("keeps the ticket system to its own tenant", async () => {
    expect(await withTenant(tB.id, () => sys.loadTicketSystem())).toBeNull();
    expect((await withTenant(tA.id, () => sys.loadTicketSystem()))?.tenantId).toBe(tA.id);
  });

  it("refuses a request without a usable ticket where one is needed", async () => {
    tickets.set("CHG0000001", { state: "Closed", approval: "approved", assignee: email(u.v1) });
    tickets.set("CHG0000002", { state: "Implement", approval: "approved", assignee: email(u.v2) });
    expect(await gateFor([site.req], undefined)).toMatchObject({ ok: false, error: "ticket_required" });
    expect(await gateFor([site.off], undefined)).toMatchObject({ ok: true, ticket: null });
    expect(await gateFor([site.req], "CHG0009999")).toMatchObject({ ok: false, error: "ticket_not_found" });
    expect(await gateFor([site.req], "CHG0000001")).toMatchObject({ ok: false, error: "ticket_state" });
    expect(await gateFor([site.req], "CHG0000002")).toMatchObject({ ok: false, error: "ticket_assignee" });
  });

  it("approves by an approved ticket only where that is the rule, inside its window", async () => {
    const end = new Date(Date.now() + 3 * 3_600_000);
    tickets.set("CHG0000003", { state: "Implement", approval: "approved", assignee: email(u.v1), end: end.toISOString().slice(0, 19).replace("T", " ") });
    const req = await gateFor([site.req], "chg0000003");
    expect(req).toMatchObject({ ok: true, approvedByTicket: false, clamped: true });
    const itsm = await gateFor([site.itsm], "CHG0000003");
    expect(itsm).toMatchObject({ ok: true, approvedByTicket: true });
    if (!itsm.ok) throw new Error("gate");
    expect(Math.abs(itsm.endsAt!.getTime() - end.getTime())).toBeLessThan(1000);
    const r = await withTenant(tA.id, () => grants.createAccessRequest({ userId: u.v1, siteId: site.itsm, startsAt: itsm.startsAt, endsAt: itsm.endsAt, note: "patch", schedule: null, ticket: itsm.ticket, approvedByTicket: true }));
    if (!r.ok) throw new Error("request");
    const g = await grant(r.id);
    expect(g.approvedAt).not.toBeNull();
    expect(g).toMatchObject({ status: "ACTIVE", ticketVerified: true });
    expect(g.ticket).toMatchObject({ system: "servicenow", state: "Implement", table: "change_request", sysId: "sys-CHG0000003" });
  });

  it("keeps a request for a person to decide when the ticket system doesn't answer", async () => {
    await owner.$executeRawUnsafe(`UPDATE "TicketSystem" SET "baseUrl" = 'http://127.0.0.1:1' WHERE "tenantId" = $1`, tA.id);
    const g = await gateFor([site.itsm], "CHG0000003");
    await owner.$executeRawUnsafe(`UPDATE "TicketSystem" SET "baseUrl" = $2 WHERE "tenantId" = $1`, tA.id, base);
    expect(g).toMatchObject({ ok: true, unverified: true, approvedByTicket: false, ticket: { ticketVerified: false } });
    const row = (await owner.$queryRawUnsafe<{ lastError: string | null }[]>(`SELECT "lastError" FROM "TicketSystem" WHERE "tenantId" = $1`, tA.id))[0];
    expect(row.lastError).toMatch(/reach/i);
  });

  it("queues a work note for a session under a ticket, once per opening spell, and sends it", async () => {
    const ev = { userId: u.v1, siteId: site.itsm, decision: "ALLOW", reason: "session_open", host: "crm" };
    expect(await withTenant(tA.id, () => noteMod.queueSessionNotes([ev, { ...ev, reason: "session_close 12m" }]))).toBe(2);
    expect(await withTenant(tA.id, () => noteMod.queueSessionNotes([ev]))).toBe(0);
    const sent = await noteMod.deliverTicketNotes(tA.id);
    expect(sent).toEqual({ sent: 2, failed: 0 });
    expect(notes.map((n) => n.sysId)).toEqual(["sys-CHG0000003", "sys-CHG0000003"]);
    expect(notes[0].text).toMatch(new RegExp(`${u.v1} \\(${u.v1}@vendor\\.test\\) opened a session to CRM`));
    expect(notes[1].text).toContain("after 12m");
    const seenFromB = await withTenant(tB.id, async () => (await import("@/lib/db")).db.ticketNote.count());
    expect(seenFromB).toBe(0);
  });

  it("opens a waiting request when its ticket is approved, and ends access when a ticket closes", async () => {
    tickets.set("CHG0000004", { state: "Authorize", approval: "requested", assignee: email(u.v2) });
    const pending = await gateFor([site.itsm], "CHG0000004", u.v2);
    if (!pending.ok) throw new Error("gate");
    expect(pending.approvedByTicket).toBe(false);
    const r = await withTenant(tA.id, () => grants.createAccessRequest({ userId: u.v2, siteId: site.itsm, startsAt: null, endsAt: null, note: "x", schedule: null, ticket: pending.ticket }));
    if (!r.ok) throw new Error("request");
    const live = (await owner.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "AccessGrant" WHERE "userId" = $1 AND "siteId" = $2`, u.v1, site.itsm))[0].id;

    const soon = new Date(Date.now() + 3_600_000);
    tickets.set("CHG0000004", { state: "Scheduled", approval: "approved", assignee: email(u.v2), end: soon.toISOString().slice(0, 19).replace("T", " ") });
    tickets.set("CHG0000003", { state: "Closed", approval: "approved", assignee: email(u.v1) });
    const pass = await recheck.runTicketPass(tA.id);
    expect(pass).toMatchObject({ checked: 2, ended: 1, approved: 1, shortened: 1, failed: 0 });
    expect(pass.approvedMail).toEqual([{ to: email(u.v2), site: "CRM" }]);

    expect(await grant(live)).toMatchObject({ status: "REVOKED", revokeReason: "ticket:state" });
    const opened = await grant(r.id);
    expect(opened.approvedAt).not.toBeNull();
    expect(Math.abs(opened.endsAt!.getTime() - soon.getTime())).toBeLessThan(1000);
    const audit = await owner.$queryRawUnsafe<{ action: string; actorId: string | null; summary: string }[]>(`SELECT action, "actorId", summary FROM "AdminAuditEvent" WHERE "tenantId" = $1 AND "targetId" = ANY($2) ORDER BY timestamp`, tA.id, [live, r.id]);
    expect(audit.map((a) => a.action).sort()).toEqual(["grant.approve", "grant.revoke", "grant.update"]);
    expect(audit.find((a) => a.action === "grant.revoke")!.summary).toContain('"Closed"');
    const bell = await owner.$queryRawUnsafe<{ type: string }[]>(`SELECT type FROM "Notification" WHERE "tenantId" = $1 ORDER BY "createdAt"`, tA.id);
    expect(bell.map((b) => b.type)).toEqual(expect.arrayContaining(["ticket_ended", "ticket_approved"]));
  });

  it("leaves everything as it is when the ticket system doesn't answer", async () => {
    await owner.$executeRawUnsafe(`UPDATE "TicketSystem" SET "baseUrl" = 'http://127.0.0.1:1' WHERE "tenantId" = $1`, tA.id);
    const pass = await recheck.runTicketPass(tA.id);
    await owner.$executeRawUnsafe(`UPDATE "TicketSystem" SET "baseUrl" = $2 WHERE "tenantId" = $1`, tA.id, base);
    expect(pass).toMatchObject({ checked: 0, ended: 0, failed: 1 });
  });
});
