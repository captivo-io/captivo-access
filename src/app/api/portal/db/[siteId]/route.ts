import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/current-user";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { SUPPORT_COOKIE } from "@/lib/support/session";
import { sha256 } from "@/lib/auth/tokens";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { databaseTarget, grantEnd } from "@/lib/database/target";
import { DB_TICKET_TTL_MS, dbPublicHost, dbPublicPort } from "@/lib/database/params";
import { dbTicketHash, newDbTicket } from "@/lib/database/ticket";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the data plane runs the proxy (it needs a certificate). */
async function proxyOn(): Promise<boolean> {
  const secret = process.env.DATAPLANE_SECRET;
  if (!secret) return false;
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const res = await fetchWithTimeout(`${base}/db-info`, { timeoutMs: 4_000, method: "POST", headers: { "x-dataplane-secret": secret } }).catch(() => null);
  const j = res?.ok ? ((await res.json().catch(() => ({}))) as { enabled?: boolean }) : null;
  return !!j?.enabled;
}

// Connection details for the signed-in user's own database client: the
// proxy's address and a ticket to sign in with as the user name. The ticket
// starts connections for up to eight hours, never past the grant's end or the
// browser session's, and ends with that session (signing out). Each click
// makes a new one; earlier ones keep working until they end.
export const POST = withTenantRoute(async (req: Request, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = await cookies();
  const token = c.get(SUPPORT_COOKIE)?.value || c.get(SESSION_COOKIE)?.value || "";
  const session = token ? await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { id: true, expiresAt: true } }) : null;
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { siteId } = await ctx.params;
  const now = new Date();
  const t = await databaseTarget(user.id, siteId, now);
  if (!t.ok) return NextResponse.json({ error: t.error }, { status: t.status === 409 ? 409 : t.status === 403 ? 403 : 404 });
  if (!(await proxyOn())) return NextResponse.json({ error: "proxy_off" }, { status: 503 });

  const end = await grantEnd(user.id, siteId, now);
  const limits = [now.getTime() + DB_TICKET_TTL_MS, session.expiresAt.getTime(), ...(end ? [end.getTime()] : [])];
  const expiresAt = new Date(Math.min(...limits));
  const ticket = newDbTicket();
  await db.dbTicket.deleteMany({ where: { userId: user.id, expiresAt: { lt: now } } });
  await db.dbTicket.create({ data: { codeHash: dbTicketHash(ticket), userId: user.id, siteId, sessionId: session.id, expiresAt } });

  const consoleHost = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).hostname;
  return NextResponse.json({
    ticket,
    expiresAt: expiresAt.toISOString(),
    host: dbPublicHost(consoleHost),
    port: dbPublicPort(),
    database: t.params.database,
    databases: t.params.databases,
    engine: t.engine,
    recorded: t.record,
  }, { headers: { "cache-control": "no-store" } });
});
