import { currentTenantId } from "@/lib/tenant/context";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { mintRdpTicket } from "@/lib/gateway/rdp-ticket";
import { nativeRdpTarget } from "@/lib/gateway/native-rdp-target";
import { rdpFile, rdpFileName } from "@/lib/gateway/native-rdp";

/**
 * A .rdp file for a user's own Remote Desktop client: the resource's server
 * behind this host's RD Gateway, with a ticket that can start a session for the
 * next two minutes. On a recorded resource Captivo signs in, so the file asks for
 * no credentials. The portal's download and the agent API both come here. Runs
 * inside the resource's tenant scope.
 */
export async function issueRdpFile(user: { id: string }, siteId: string, req: { headers: Headers; url: string }): Promise<{ status: number; error?: string; body?: string; fileName?: string; recorded?: boolean; expiresAt?: Date }> {
  const secret = process.env.DATAPLANE_SECRET;
  if (!secret) return { status: 503, error: "gateway_not_configured" };
  const now = new Date();
  const t = await nativeRdpTarget(user.id, siteId, now);
  if (!t.ok) return { status: t.status === 409 ? 409 : 404, error: t.error };
  const gatewayHost = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).host;
  const ticket = mintRdpTicket({ tenantId: currentTenantId(), siteId, userId: user.id }, { secret, now });
  const body = rdpFile({ gatewayHost, targetHost: t.targetHost, targetPort: t.targetPort, token: ticket.token, redirection: t.redirection, recorded: t.mode === "recorded" });
  return { status: 200, body, fileName: rdpFileName(t.siteName), recorded: t.mode === "recorded", expiresAt: ticket.expiresAt };
}
