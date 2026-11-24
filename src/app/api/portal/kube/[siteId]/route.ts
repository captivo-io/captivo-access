import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/current-user";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { SUPPORT_COOKIE } from "@/lib/support/session";
import { sha256 } from "@/lib/auth/tokens";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { grantEnd } from "@/lib/database/target";
import { dbTicketHash, newDbTicket } from "@/lib/database/ticket";
import { kubeTarget } from "@/lib/kubernetes/target";
import { KUBE_TICKET_TTL_MS, kubeconfigYaml, kubeContextName, kubeServerUrl } from "@/lib/kubernetes/params";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A kubeconfig for the signed-in user's own kubectl: the console's address
// under /k8s/ and a token that is a connection ticket. It works for up to
// eight hours, never past the grant's end or the browser session's, and ends
// with that session (signing out). Each click makes a new one; earlier ones
// keep working until they end.
export const POST = withTenantRoute(async (req: Request, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = await cookies();
  const token = c.get(SUPPORT_COOKIE)?.value || c.get(SESSION_COOKIE)?.value || "";
  const session = token ? await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { id: true, expiresAt: true } }) : null;
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { siteId } = await ctx.params;
  const now = new Date();
  const t = await kubeTarget(user.id, siteId, now);
  if (!t.ok) return NextResponse.json({ error: t.error }, { status: t.status === 409 ? 409 : t.status === 403 ? 403 : 404 });

  const end = await grantEnd(user.id, siteId, now);
  const expiresAt = new Date(Math.min(now.getTime() + KUBE_TICKET_TTL_MS, session.expiresAt.getTime(), ...(end ? [end.getTime()] : [])));
  const ticket = newDbTicket();
  await db.dbTicket.deleteMany({ where: { userId: user.id, expiresAt: { lt: now } } });
  await db.dbTicket.create({ data: { codeHash: dbTicketHash(ticket), userId: user.id, siteId, sessionId: session.id, expiresAt } });

  const origin = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).origin;
  const context = kubeContextName(t.siteName);
  const server = kubeServerUrl(origin, siteId);
  return NextResponse.json({
    kubeconfig: kubeconfigYaml({ server, context, token: ticket, namespace: t.params.namespaces[0] ?? null, expiresAt }),
    fileName: `${context}.yaml`,
    context,
    server,
    expiresAt: expiresAt.toISOString(),
    namespaces: t.params.namespaces,
    readOnly: t.params.readOnly,
    portForward: t.params.portForward,
    actsAs: t.impersonateUser || null,
    recorded: t.record,
  }, { headers: { "cache-control": "no-store" } });
});
