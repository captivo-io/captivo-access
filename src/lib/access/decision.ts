import { decideGrant } from "@/lib/access/grants";
import { normalizeDenyReason } from "@/lib/access/deny-reason";
import { db } from "@/lib/db";
import { sendMail } from "@/lib/email/mailer";
import { accessDecisionEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { recordAdminAction } from "@/lib/audit/admin";
import { consoleBaseUrl } from "@/lib/tenant/console-url";

/**
 * Approve or deny a pending access request, with everything that goes with
 * it: the admin audit row and the vendor's e-mail. Shared by the console and
 * the app so a decision means the same wherever it was made.
 */
export async function applyGrantDecision(input: {
  actor: { id: string; email: string };
  grantId: string;
  decision: "approve" | "deny";
  reason?: unknown;
  clientIp: string | null;
  via?: "app";
}): Promise<"ok" | "not_pending"> {
  const { actor, grantId: id, decision } = input;
  const count = await decideGrant(id, decision, actor.id, normalizeDenyReason(input.reason));
  if (count === 0) return "not_pending";

  await recordAdminAction({
    actor,
    action: decision === "approve" ? "grant.approve" : "grant.deny",
    targetType: "grant", targetId: id,
    summary: `${decision === "approve" ? "Approved" : "Denied"} access request ${id}${input.via === "app" ? " (Captivo Admin app)" : ""}`,
    clientIp: input.clientIp,
  });

  if (await notifyEmailEnabled("access_decisions")) {
    try {
      const grant = await db.accessGrant.findUnique({
        where: { id },
        select: { user: { select: { email: true } }, site: { select: { name: true } } },
      });
      if (grant?.user?.email) {
        const m = accessDecisionEmail({
          decision: decision === "approve" ? "approved" : "denied",
          siteName: grant.site.name,
          consoleUrl: await consoleBaseUrl(),
        });
        await sendMail({ to: grant.user.email, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best-effort: emailing the vendor must never change the decision outcome.
    }
  }
  return "ok";
}
