import { getAdminEmails, sendMail } from "@/lib/email/mailer";
import { approvalRequestEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { pushToCapability } from "@/lib/mobile/push";

/** Tells the people who approve access that an agent is waiting, by mail and on their phone. Best effort: it never decides anything. */
export async function notifyApprovers(o: { who: string; email: string; siteName: string; grantId: string; reason: string; ticketRef?: string }): Promise<void> {
  if (await notifyEmailEnabled("access_requests")) {
    try {
      const admins = await getAdminEmails();
      if (admins.length > 0) {
        const m = approvalRequestEmail({ vendorName: o.who, vendorEmail: o.email, siteName: o.siteName, ticket: null, consoleUrl: await consoleBaseUrl() });
        await sendMail({ to: admins, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best effort.
    }
  }
  try {
    await pushToCapability("approve_grants", {
      title: "Access request",
      body: `${o.who} asks for ${o.siteName}: ${o.reason.slice(0, 80)}${o.ticketRef ? ` (${o.ticketRef})` : ""}`,
      data: { type: "access_request", grantId: o.grantId, origin: await consoleBaseUrl() },
      categoryId: "access_request",
    });
  } catch {
    // Best effort.
  }
}
