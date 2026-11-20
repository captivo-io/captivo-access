// The pump against a real database: records are read after the cursors,
// delivered, and only then do the cursors move; a refused batch is kept and
// sent again once the destination answers. Self-host mode (one implicit
// tenant), so the delivery goes to a local HTTP server without the cloud's
// private-address guard.
//
// Requires a live Postgres via TEST_DATABASE_URL (owner connection, schema
// pushed); SKIPPED otherwise. MUST run in its own vitest process (sets
// DATABASE_URL before the db module loads).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const OWNER_URL = process.env.TEST_DATABASE_URL;
const suffix = crypto.randomUUID().slice(0, 8);

describe.skipIf(!OWNER_URL)("log forwarding pump", () => {
  let owner: PrismaClient;
  let server: Server;
  let url: string;
  const received: { status: number; events: { action: string; message: string }[] }[] = [];
  let answer = 200;
  let id: string;
  let pump: typeof import("./pump");
  let appendAuditEvents: typeof import("@/lib/audit/append").appendAuditEvents;

  const event = (path: string, decision = "ALLOW") => ({ host: `it-${suffix}.local`, method: "GET", path, status: 200, decision, reason: decision === "DENY" ? "no_grant" : undefined });
  const row = () => owner.logDestination.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
    await owner.$executeRawUnsafe(`INSERT INTO "Tenant"(id,slug,name,status) VALUES('default','default','default','ACTIVE') ON CONFLICT (id) DO NOTHING`);
    process.env.DATABASE_URL = OWNER_URL!;
    delete process.env.MULTI_TENANT;
    delete (globalThis as { prismaBase?: unknown }).prismaBase;

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ status: answer, events: JSON.parse(body) });
        res.statusCode = answer;
        res.end(answer === 200 ? "ok" : "busy");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/in`;

    pump = await import("./pump");
    ({ appendAuditEvents } = await import("@/lib/audit/append"));
    const { startCursors } = await import("./cursor");
    const created = await owner.logDestination.create({
      data: { name: `IT ${suffix}`, kind: "https", url, sendRequests: true, ...(await startCursors(null)) },
    });
    id = created.id;
  });

  afterAll(async () => {
    await owner.logDestination.deleteMany({ where: { id } });
    await owner.auditEvent.deleteMany({ where: { host: `it-${suffix}.local` } });
    await owner.$disconnect();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("delivers what was written after the cursor and moves it", async () => {
    await appendAuditEvents([event("/a"), event("/b"), event("/c", "DENY")]);
    await pump.pumpDestination(null, id);
    expect(received).toHaveLength(1);
    expect(received[0].events.map((e) => e.action)).toEqual(["access.request", "access.request", "access.deny"]);
    const d = await row();
    expect(d.sentTotal).toBe(BigInt(3));
    expect(d.lastError).toBeNull();
  });

  it("keeps a refused batch and waits before the next attempt", async () => {
    const before = await row();
    answer = 503;
    await appendAuditEvents([event("/d"), event("/e")]);
    await pump.pumpDestination(null, id);
    const d = await row();
    expect(d.accessCursor).toBe(before.accessCursor);
    expect(d.failures).toBe(1);
    expect(d.lastError).toContain("HTTP 503");
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Inside the wait, an ordinary pump leaves it alone.
    const calls = received.length;
    await pump.pumpTenant(null);
    expect(received).toHaveLength(calls);
  });

  it("sends the same records again once the destination answers", async () => {
    answer = 200;
    await pump.pumpTenant(null, { force: true });
    const last = received[received.length - 1];
    expect(last.status).toBe(200);
    expect(last.events.map((e) => e.message)).toEqual([expect.stringContaining("/d"), expect.stringContaining("/e")]);
    const d = await row();
    expect(d.failures).toBe(0);
    expect(d.nextAttemptAt).toBeNull();
    expect(d.sentTotal).toBe(BigInt(5));
  });

  it("moves past records nobody asked for without a call", async () => {
    await owner.logDestination.update({ where: { id }, data: { sendRequests: false, sendDenied: false } });
    const calls = received.length;
    const before = await row();
    await appendAuditEvents([event("/f")]);
    await pump.pumpDestination(null, id);
    expect(received).toHaveLength(calls);
    const d = await row();
    expect(d.accessCursor).toBe(before.accessCursor + BigInt(1));
    expect(d.sentTotal).toBe(before.sentTotal);
  });
});
