import { currentTenantId } from "@/lib/tenant/context";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { nativeSshTarget } from "@/lib/gateway/native-ssh-target";
import { SSH_TICKET_TTL_MS, sshPublicHost, sshPublicPort } from "@/lib/gateway/native-ssh";
import { newSshTicketCode } from "@/lib/gateway/native-ssh-ticket";
import { hasAdmission } from "@/lib/moderation/requests";

const TICKET_TIMEOUT_MS = 4_000;

/**
 * A command's worth of SSH for this user and resource: the resource's server
 * behind the jump host, with a ticket as the jump user name that starts
 * connections for the next two minutes; for a TCP tunnel resource, the port
 * forward to its service. Each call makes a new one. The ticket is registered
 * with the data plane, which runs the jump host. The portal's button and the
 * agent API both come here. Runs inside the resource's tenant scope.
 */
export async function issueSshTicket(user: { id: string }, siteId: string, req: { headers: Headers; url: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = process.env.DATAPLANE_SECRET;
  if (!secret) return { status: 503, body: { error: "gateway_not_configured" } };
  const now = new Date();
  const t = await nativeSshTarget(user.id, siteId, now);
  if (!t.ok) return { status: t.status === 409 ? 409 : 404, body: { error: t.error } };
  // A moderated resource: the command comes once a moderator admitted the session.
  if (t.moderated && !(await hasAdmission(siteId, user.id, "ssh", now))) return { status: 409, body: { error: "moderator_required" } };

  const code = newSshTicketCode();
  const expiresAt = new Date(now.getTime() + SSH_TICKET_TTL_MS);
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const res = await fetchWithTimeout(`${base}/ssh-ticket`, {
    timeoutMs: TICKET_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": secret },
    body: JSON.stringify({ code, tenantId: currentTenantId(), siteId, userId: user.id, expiresAt: expiresAt.toISOString() }),
  }).catch(() => null);
  const j = res?.ok ? ((await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; fingerprint?: string }) : null;
  if (!j?.ok) return { status: 503, body: { error: j?.reason === "ssh_off" ? "ssh_off" : "gateway_unavailable" } };

  const consoleHost = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).hostname;
  return {
    status: 200,
    body: {
      code,
      expiresAt: expiresAt.toISOString(),
      jumpHost: sshPublicHost(consoleHost),
      jumpPort: sshPublicPort(),
      targetHost: t.targetHost,
      targetPort: t.targetPort,
      fingerprint: j.fingerprint ?? null,
      // A TCP tunnel: the command forwards a local port to the service (lib/gateway/tcp-tunnel.ts).
      tunnel: t.mode === "tunnel",
      // Recorded: Captivo signs in as the saved account, and the session follows the resource's rules.
      recorded: t.mode === "recorded",
      ...(t.mode === "recorded" ? { username: t.username, fileTransfer: t.fileTransfer } : {}),
    },
  };
}
