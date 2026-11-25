import { db } from "@/lib/db";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { grantEnd } from "@/lib/database/target";
import { dbTicketHash, newDbTicket } from "@/lib/database/ticket";
import { kubeTarget } from "@/lib/kubernetes/target";
import { KUBE_TICKET_TTL_MS, kubeconfigYaml, kubeContextName, kubeServerUrl } from "@/lib/kubernetes/params";

/**
 * A kubeconfig for a user's own kubectl: the console's address under /k8s/ and
 * a token that is a connection ticket. It works for up to eight hours, never
 * past the grant's end or the session's, and ends with that session. The
 * portal's button and the agent API both come here. Runs inside the
 * resource's tenant scope.
 */
export async function issueKubeTicket(user: { id: string }, session: { id: string; expiresAt: Date }, siteId: string, req: { headers: Headers; url: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = new Date();
  const t = await kubeTarget(user.id, siteId, now);
  if (!t.ok) return { status: t.status === 409 ? 409 : t.status === 403 ? 403 : 404, body: { error: t.error } };

  const end = await grantEnd(user.id, siteId, now);
  const expiresAt = new Date(Math.min(now.getTime() + KUBE_TICKET_TTL_MS, session.expiresAt.getTime(), ...(end ? [end.getTime()] : [])));
  const ticket = newDbTicket();
  await db.dbTicket.deleteMany({ where: { userId: user.id, expiresAt: { lt: now } } });
  await db.dbTicket.create({ data: { codeHash: dbTicketHash(ticket), userId: user.id, siteId, sessionId: session.id, expiresAt } });

  const origin = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).origin;
  const context = kubeContextName(t.siteName);
  const server = kubeServerUrl(origin, siteId);
  return {
    status: 200,
    body: {
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
    },
  };
}
