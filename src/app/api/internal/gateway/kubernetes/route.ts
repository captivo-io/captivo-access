import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { resolvedVendorIpAllowlist } from "@/lib/settings/platform";
import { ipAllowed } from "@/lib/net/cidr";
import { kubeTarget } from "@/lib/kubernetes/target";
import { dbTicketHash } from "@/lib/database/ticket";
import { requireDataplaneSecret, resolveTenantByDbTicket, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  return ticket ? resolveTenantByDbTicket(dbTicketHash(ticket)) : null;
}

// The Kubernetes proxy asks this when a kubeconfig's token starts a session,
// and once a minute for each open one: is the token still good (not expired,
// its browser session not ended), does the grant hold, where is the API
// server, who do the requests act as, and the resource's rules. 404 = no such
// token (any more), 403 = no access now, 409 = the resource can't be reached
// as a cluster. No token leaves here: only seals the connectors open.
async function handler(req: NextRequest) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ticket = typeof b.ticket === "string" ? b.ticket : "";
  const clientIp = typeof b.clientIp === "string" ? b.clientIp : "";
  const now = new Date();
  const row = await db.dbTicket.findUnique({
    where: { codeHash: dbTicketHash(ticket) },
    select: { id: true, userId: true, siteId: true, expiresAt: true, lastUsedAt: true, session: { select: { expiresAt: true } } },
  });
  if (!row || row.expiresAt <= now || row.session.expiresAt <= now) return NextResponse.json({ error: "unknown_ticket" }, { status: 404 });

  const allowlist = await resolvedVendorIpAllowlist();
  if (allowlist && !ipAllowed(allowlist, clientIp)) return NextResponse.json({ error: "forbidden", reason: "ip_not_allowed" }, { status: 403 });

  const t = await kubeTarget(row.userId, row.siteId, now);
  if (!t.ok) return NextResponse.json({ error: t.error, reason: t.reason }, { status: t.status });
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await db.dbTicket.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  }
  return NextResponse.json({
    tenantId: currentTenantId(),
    siteId: row.siteId,
    userId: row.userId,
    siteName: t.siteName,
    targetHost: t.targetHost,
    targetPort: t.targetPort,
    username: t.username,
    caCertPem: t.params.caCertPem ?? "",
    serverName: t.params.serverName ?? "",
    impersonateUser: t.impersonateUser,
    impersonateGroups: t.impersonateGroups,
    readOnly: t.params.readOnly,
    namespaces: t.params.namespaces,
    portForward: t.params.portForward,
    connectors: t.connectors,
    record: t.record,
    keystrokeLogging: t.keystrokeLogging,
  });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
