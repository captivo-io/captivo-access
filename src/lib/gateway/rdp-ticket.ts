import { createHmac, randomBytes } from "node:crypto";

// The RD Gateway access token a downloaded .rdp file carries
// (gatewayaccesstoken): who, which resource, until when. Signed with a key
// derived from DATAPLANE_SECRET, which the data plane shares, so the gateway
// verifies it without a round trip (dataplane/rdpticket.go is the other half).
// It only lets a tunnel START: the grant is checked when the tunnel opens and
// every minute after, so a file kept past a revoke opens nothing.

const PREFIX = "cr1.";

/** How long a downloaded file can start a session. */
export const RDP_TICKET_TTL_MS = 2 * 60_000;

export interface RdpTicket { tenantId: string; siteId: string; userId: string; expiresAt: Date }

function ticketKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("captivo-rdp-ticket-v1").digest();
}

export function mintRdpTicket(
  t: { tenantId: string; siteId: string; userId: string },
  opts: { secret: string; now: Date; nonce?: string },
): RdpTicket & { token: string } {
  const expiresAt = new Date(opts.now.getTime() + RDP_TICKET_TTL_MS);
  const payload = { t: t.tenantId, s: t.siteId, u: t.userId, e: Math.floor(expiresAt.getTime() / 1000), n: opts.nonce ?? randomBytes(8).toString("hex") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", ticketKey(opts.secret)).update(PREFIX + body).digest("base64url");
  return { ...t, expiresAt, token: `${PREFIX}${body}.${sig}` };
}
