import { terminateSession } from "@/lib/dataplane/client";
import { revokeGrant } from "@/lib/access/grants";
import { recordAdminAction } from "@/lib/audit/admin";

/**
 * End a live session, optionally revoking the grant behind it so the vendor
 * cannot simply reconnect. Shared by the console and the app.
 */
export async function terminateLiveSession(input: {
  actor: { id: string; email: string };
  sessionId: string;
  grantId: string | null;
  clientIp: string | null;
  via?: "app";
}) {
  const { actor, sessionId, grantId } = input;
  const suffix = input.via === "app" ? " (Captivo Admin app)" : "";
  const result = await terminateSession(sessionId);
  await recordAdminAction({
    actor,
    action: "session.terminate",
    targetType: "session", targetId: sessionId,
    summary: (grantId ? `Terminated session ${sessionId} and revoked grant ${grantId}` : `Terminated session ${sessionId}`) + suffix,
    clientIp: input.clientIp,
  });
  if (grantId) {
    await revokeGrant(grantId);
    await recordAdminAction({
      actor,
      action: "grant.revoke",
      targetType: "grant", targetId: grantId,
      summary: `Revoked access grant ${grantId} (session terminate)${suffix}`,
      clientIp: input.clientIp,
    });
  }
  return { ...result, revoked: !!grantId };
}
