import { db } from "@/lib/db";
import { inTenant } from "@/lib/cron/for-each-tenant";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import type { AuditInput } from "@/lib/audit/append";
import { addTicketNote, describeSystemError } from "./providers";
import { checksTickets, loadTicketSystem, systemSecret, systemSpec } from "./system";
import { noteText, readSnapshot } from "./rules";
import { effectiveSiteRecording } from "@/lib/recording/effective";

// Work notes on tickets: when a session under a ticketed grant opens or
// closes, a note saying who, where and for how long is queued here (with the
// audit batch that recorded it) and sent outside the tenant scope. A note that
// can't be sent is tried again by the tickets cron, a few times.

/** A web app opens a session per page load; one "opened" note per grant in this long is enough. */
const OPEN_NOTE_GAP_MS = 30 * 60_000;
const MAX_ATTEMPTS = 8;
const BATCH = 50;

const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3_600_000);

/** Queues notes for the session events in one audit batch (inside the tenant scope). */
export async function queueSessionNotes(events: AuditInput[], now = new Date()): Promise<number> {
  const relevant = events.filter((e) => e.userId && e.siteId && e.decision === "ALLOW" && /^session_(open|close)\b/.test(e.reason ?? ""));
  if (!relevant.length) return 0;
  const sys = await loadTicketSystem();
  if (!checksTickets(sys) || !sys.writeNotes) return 0;
  const base = await consoleBaseUrl().catch(() => "");
  let queued = 0;
  for (const e of relevant) {
    const g = await db.accessGrant.findFirst({
      where: { userId: e.userId, siteId: e.siteId, status: "ACTIVE", ticketRef: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, ticketRef: true, user: { select: { name: true, email: true } }, site: { select: { name: true, recordSessions: true } } },
    });
    if (!g?.ticketRef) continue;
    const at = e.timestamp ? new Date(e.timestamp) : now;
    const n = noteText({
      reason: e.reason!, who: g.user.name ?? g.user.email, email: g.user.email, site: g.site.name, at,
      // A link to recordings only where sessions are recorded.
      recordingsUrl: base && (await effectiveSiteRecording(g.site.recordSessions)) ? `${base}/admin/recordings?q=${encodeURIComponent(g.ticketRef)}` : null,
    });
    if (!n) continue;
    if (n.kind === "open") {
      const recent = await db.ticketNote.findFirst({ where: { grantId: g.id, kind: "open", createdAt: { gt: new Date(now.getTime() - OPEN_NOTE_GAP_MS) } }, select: { id: true } });
      if (recent) continue;
    }
    await db.ticketNote.create({ data: { grantId: g.id, ticketRef: g.ticketRef, kind: n.kind, body: n.body } });
    queued++;
  }
  return queued;
}

/** Sends what is due. Reads and writes in the tenant's scope; the calls outside it. */
export async function deliverTicketNotes(tenantId: string | null, now = new Date()): Promise<{ sent: number; failed: number }> {
  const read = await inTenant(tenantId, async () => {
    const sys = await loadTicketSystem();
    if (!checksTickets(sys)) return null;
    const notes = await db.ticketNote.findMany({
      where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS }, nextAttemptAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    if (!notes.length) return null;
    const grants = await db.accessGrant.findMany({ where: { id: { in: notes.map((n) => n.grantId).filter((x): x is string => !!x) } }, select: { id: true, ticket: true } });
    return { sys, notes, handles: new Map(grants.map((g) => [g.id, readSnapshot(g.ticket)])) };
  });
  if (!read) return { sent: 0, failed: 0 };
  const secret = systemSecret(read.sys);
  if (secret === undefined) return { sent: 0, failed: 0 };
  const results: { id: string; error: string | null; attempts: number }[] = [];
  for (const n of read.notes) {
    const h = n.grantId ? read.handles.get(n.grantId) : null;
    try {
      await addTicketNote(systemSpec(read.sys), secret, { ref: n.ticketRef, table: h?.table ?? null, sysId: h?.sysId ?? null }, n.kind, n.body);
      results.push({ id: n.id, error: null, attempts: n.attempts + 1 });
    } catch (e) {
      results.push({ id: n.id, error: describeSystemError(e).slice(0, 300), attempts: n.attempts + 1 });
    }
  }
  await inTenant(tenantId, async () => {
    for (const r of results) {
      await db.ticketNote.update({
        where: { id: r.id },
        data: r.error
          ? { attempts: r.attempts, lastError: r.error, nextAttemptAt: new Date(now.getTime() + backoffMs(r.attempts)) }
          : { attempts: r.attempts, sentAt: now, lastError: null },
      });
    }
  });
  return { sent: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length };
}
