import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { managerVersion } from "@/lib/version";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { currentTenantId, outsideScope } from "@/lib/tenant/context";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { inTenant } from "@/lib/cron/for-each-tenant";
import { accessRecord, adminRecord, wanted, type LogRecord } from "./records";
import { syslogLine, type FormatContext } from "./format";
import { deliverCloud, deliverSyslog, tryAnotherConnector, type Delivery } from "./deliver";

// The queue is the audit log itself. Each destination keeps a cursor into the
// access chain and one into the admin chain; a batch is read after them,
// delivered, and only then are the cursors moved. A failed batch is read and
// sent again on the next attempt, so a SIEM can see a record twice but never
// misses one.
//
// Reads and writes run in the tenant's scope (a transaction with a short
// budget); the delivery, which waits on someone else's machine, runs outside it.

const BATCH = 500;
/** Batches per destination per pump: a backlog drains over several pumps rather than holding one. */
const MAX_ROUNDS = 20;
/** A syslog batch is one control frame of at most 1 MiB, JSON-escaped. */
const SYSLOG_CHUNK_BYTES = 512 * 1024;

/** Wait before the next attempt after `failures` failed ones: 30 s doubling, at most 5 min. */
export function backoffMs(failures: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000);
}

/** Splits rendered messages into chunks of at most `max` bytes (a message larger than that is a chunk of its own). */
export function chunkByBytes(lines: string[], max: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const l of lines) {
    const n = Buffer.byteLength(l) + 16;
    if (cur.length && size + n > max) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function formatContext(): Promise<FormatContext> {
  const base = await consoleBaseUrl().catch(() => "");
  let hostname = "captivo-access";
  try {
    if (base) hostname = new URL(base).hostname;
  } catch {
    /* keep the default */
  }
  return { version: managerVersion(), hostname, workspace: hostname.split(".")[0] || "default" };
}

type Dest = NonNullable<Awaited<ReturnType<typeof loadDestination>>>;

function loadDestination(id: string) {
  return db.logDestination.findUnique({ where: { id } });
}

const ACCESS_SELECT = {
  seq: true, timestamp: true, userEmail: true, userName: true, company: true, siteId: true, siteName: true, host: true,
  method: true, path: true, status: true, bytesOut: true, decision: true, reason: true, clientIp: true, userAgent: true, hash: true,
} as const;
const ADMIN_SELECT = { seq: true, timestamp: true, actorEmail: true, action: true, targetType: true, targetId: true, summary: true, clientIp: true, hash: true } as const;

/** What delivery needs from a destination: its stored row, or the form's values for a test. */
export type DeliverySpec = Pick<Dest,
  "kind" | "transport" | "host" | "port" | "framing" | "format" | "facility" | "caPem" | "connectorId" | "fallbackConnectorId" | "url" | "headerName">;

/** Sends records to one destination, the way its kind is reached. `secret` is the plain token or key. */
export async function deliverTo(d: DeliverySpec, secret: string | null, records: LogRecord[], ctx: FormatContext): Promise<Delivery> {
  if (d.kind === "syslog") {
    if (!d.transport || !d.host || !d.port || !d.connectorId) return { ok: false, reason: "incomplete" };
    const lines = records.map((r) => syslogLine(r, ctx, { format: d.format === "json" ? "json" : "cef", facility: d.facility }));
    const target = { transport: d.transport, host: d.host, port: d.port, framing: d.framing, caPem: d.caPem };
    let last: Delivery = { ok: false, reason: "no_answer" };
    for (const chunk of chunkByBytes(lines, SYSLOG_CHUNK_BYTES)) {
      last = await deliverSyslog(d.connectorId, target, chunk);
      if (!last.ok && d.fallbackConnectorId && tryAnotherConnector(last.reason)) {
        last = await deliverSyslog(d.fallbackConnectorId, target, chunk);
      }
      if (!last.ok) return last;
    }
    return last;
  }
  if (!d.url) return { ok: false, reason: "incomplete" };
  return deliverCloud({ kind: d.kind, url: d.url, headerName: d.headerName }, secret, records, ctx);
}

/** The stored secret in plain text; undefined when it can't be read. */
export function storedSecret(enc: string | null): string | null | undefined {
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return undefined;
  }
}

const running = new Set<string>();

/**
 * Drains one destination as far as it goes now. Returns quietly when another
 * pump already holds it, when it is switched off, or when a delivery fails
 * (the failure is stored on the row, with the time of the next attempt).
 */
export async function pumpDestination(tenantId: string | null, id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const ctx = await inTenant(tenantId, () => formatContext());
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const read = await inTenant(tenantId, async () => {
        const d = await loadDestination(id);
        if (!d || !d.enabled) return null;
        const [access, admin] = await Promise.all([
          db.auditEvent.findMany({ where: { seq: { gt: d.accessCursor } }, orderBy: { seq: "asc" }, take: BATCH, select: ACCESS_SELECT }),
          db.adminAuditEvent.findMany({ where: { seq: { gt: d.adminCursor } }, orderBy: { seq: "asc" }, take: BATCH, select: ADMIN_SELECT }),
        ]);
        return { d, access, admin };
      });
      if (!read) return;
      const { d, access, admin } = read;
      if (access.length === 0 && admin.length === 0) return;

      const records = [...access.map(accessRecord), ...admin.map(adminRecord)]
        .filter((r) => wanted(d, r))
        .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.seq < b.seq ? -1 : 1));
      const accessCursor = access.length ? access[access.length - 1].seq : d.accessCursor;
      const adminCursor = admin.length ? admin[admin.length - 1].seq! : d.adminCursor;

      const secret = storedSecret(d.secret);
      const result: Delivery = !records.length
        ? { ok: true, latencyMs: 0 }
        : secret === undefined
          ? { ok: false, reason: "secret_unreadable" }
          : await deliverTo(d, secret, records, ctx);
      const now = new Date();
      if (!result.ok) {
        await inTenant(tenantId, () => db.logDestination.update({
          where: { id },
          data: {
            failures: { increment: 1 },
            lastError: describeFailure(result.reason, result.detail),
            lastErrorAt: now,
            nextAttemptAt: new Date(now.getTime() + backoffMs(d.failures + 1)),
          },
        }));
        return;
      }
      // Moved only from where it was read: a concurrent pump (another manager
      // process) that got there first wins, and this one stops.
      const moved = await inTenant(tenantId, () => db.logDestination.updateMany({
        where: { id, accessCursor: d.accessCursor, adminCursor: d.adminCursor },
        data: {
          accessCursor, adminCursor,
          ...(records.length ? { sentTotal: { increment: records.length }, lastSentAt: now } : {}),
          failures: 0, lastError: null, nextAttemptAt: null,
        },
      }));
      if (moved.count === 0) return;
      if (access.length < BATCH && admin.length < BATCH) return;
    }
  } finally {
    running.delete(id);
  }
}

/** Every enabled destination of one tenant whose wait after a failure is over (all of them with `force`). */
export async function pumpTenant(tenantId: string | null, opts: { force?: boolean } = {}): Promise<void> {
  const now = new Date();
  const ids = await inTenant(tenantId, () => db.logDestination.findMany({
    where: { enabled: true, ...(opts.force ? {} : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }) },
    select: { id: true },
  }));
  for (const { id } of ids) {
    await pumpDestination(tenantId, id).catch((e) => console.error("log forwarding: pump failed", id, e));
  }
}

// New records start a pump shortly after they are written, so a SIEM sees them
// within seconds; the site-health cron catches up whatever a restart or a
// failure left behind. One pending pump per tenant: records that arrive while
// it waits ride along.
const KICK_DELAY_MS = 2_000;
const pending = new Set<string>();

export function kickLogForwarding(): void {
  if (process.env.NODE_ENV === "test") return;
  const tenantId = multiTenantEnabled() ? currentTenantId() : null;
  const key = tenantId ?? "";
  if (pending.has(key)) return;
  pending.add(key);
  // Outside the caller's scope: its transaction is closed by the time this runs.
  outsideScope(() => {
    const t = setTimeout(() => {
      pending.delete(key);
      pumpTenant(tenantId).catch((e) => console.error("log forwarding: pump failed", e));
    }, KICK_DELAY_MS);
    t.unref?.();
  });
}

/** Starts a pump for the current tenant without waiting for it (after a destination is saved, or "Retry now"). */
export function pumpSoon(opts: { force?: boolean } = {}): void {
  const tenantId = multiTenantEnabled() ? currentTenantId() : null;
  outsideScope(() => {
    setTimeout(() => {
      pumpTenant(tenantId, opts).catch((e) => console.error("log forwarding: pump failed", e));
    }, 0);
  });
}

const REASONS: Record<string, string> = {
  offline: "The connector is offline.",
  connector_too_old: "The connector is older than 2.42.0 and can't forward logs. Update it.",
  no_answer: "The connector didn't answer.",
  incomplete: "The destination's settings are incomplete.",
  secret_unreadable: "The stored token can't be read. Enter it again.",
  private_address: "That address is on a private network; the cloud service can't reach it. Use syslog through a connector instead.",
  timeout: "The endpoint didn't answer within 15 seconds.",
  unreachable: "The endpoint couldn't be reached.",
};

/** A failure in words for the console. */
export function describeFailure(reason: string, detail?: string): string {
  if (reason === "send_failed") return `The connector couldn't deliver: ${detail ?? "unknown error"}`.slice(0, 300);
  const http = /^http_(\d+)$/.exec(reason);
  if (http) return `The endpoint answered HTTP ${http[1]}${detail ? `: ${detail}` : ""}`.slice(0, 300);
  const base = REASONS[reason] ?? reason;
  return (detail ? `${base} ${detail}` : base).slice(0, 300);
}
