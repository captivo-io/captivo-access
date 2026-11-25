import { db } from "@/lib/db";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { databaseTarget, grantEnd } from "@/lib/database/target";
import { DB_TICKET_TTL_MS, dbEngineOf, dbPublicHost, dbPublicPort } from "@/lib/database/params";
import { dbTicketHash, newDbTicket } from "@/lib/database/ticket";

/** Whether the data plane runs the proxy for this engine (it needs a certificate). */
async function proxyOn(engine: string): Promise<boolean> {
  const secret = process.env.DATAPLANE_SECRET;
  if (!secret) return false;
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const res = await fetchWithTimeout(`${base}/db-info`, { timeoutMs: 4_000, method: "POST", headers: { "x-dataplane-secret": secret } }).catch(() => null);
  const j = res?.ok ? ((await res.json().catch(() => ({}))) as Record<string, boolean | undefined>) : null;
  return engine === "postgres" ? !!j?.enabled : !!j?.[engine];
}

/**
 * Connection details for a user's own database client: the proxy's address and
 * a ticket to sign in with as the user name. The ticket starts connections for
 * up to eight hours, never past the grant's end or the session's, and ends with
 * that session. The portal's button and the agent API both come here. Runs
 * inside the resource's tenant scope.
 */
export async function issueDbTicket(user: { id: string }, session: { id: string; expiresAt: Date }, siteId: string, req: { headers: Headers; url: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = new Date();
  const t = await databaseTarget(user.id, siteId, now);
  if (!t.ok) return { status: t.status === 409 ? 409 : t.status === 403 ? 403 : 404, body: { error: t.error } };
  if (!(await proxyOn(t.engine))) return { status: 503, body: { error: "proxy_off" } };

  const end = await grantEnd(user.id, siteId, now);
  const limits = [now.getTime() + DB_TICKET_TTL_MS, session.expiresAt.getTime(), ...(end ? [end.getTime()] : [])];
  const expiresAt = new Date(Math.min(...limits));
  const ticket = newDbTicket();
  await db.dbTicket.deleteMany({ where: { userId: user.id, expiresAt: { lt: now } } });
  await db.dbTicket.create({ data: { codeHash: dbTicketHash(ticket), userId: user.id, siteId, sessionId: session.id, expiresAt } });

  const consoleHost = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).hostname;
  return {
    status: 200,
    body: {
      ticket,
      expiresAt: expiresAt.toISOString(),
      host: dbPublicHost(consoleHost),
      port: dbPublicPort(dbEngineOf(t.engine)),
      database: t.params.database,
      databases: t.params.databases,
      engine: t.engine,
      recorded: t.record,
    },
  };
}
