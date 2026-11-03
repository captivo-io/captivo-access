import { db } from "@/lib/db";
import { sendMail, getAdminEmails } from "@/lib/email/mailer";
import { siteEventEmail } from "@/lib/email/templates";
import { resolvedNotificationWebhookUrl } from "@/lib/settings/platform";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { pushToCapability } from "@/lib/mobile/push";

export type NotificationType = "site_down" | "site_recovered";

// Edge-triggered: only a real transition produces an event, so a Site that
// stays down doesn't notify every cycle. null (never probed) -> false counts
// as down so a newly-added, unreachable Site surfaces.
export function classifyTransition(oldOk: boolean | null, newOk: boolean): NotificationType | null {
  if (newOk === false && oldOk !== false) return "site_down";
  if (newOk === true && oldOk === false) return "site_recovered";
  return null;
}

export async function countUnreadNotifications(): Promise<number> {
  return db.notification.count({ where: { readAt: null } });
}

export async function notifyTransition(input: {
  type: NotificationType;
  siteId: string;
  siteName: string;
  detail: string | null;
}): Promise<void> {
  try {
    await db.notification.create({
      data: { type: input.type, siteId: input.siteId, siteName: input.siteName, detail: input.detail },
    });
  } catch {
    // Best-effort: a failed notification row insert must never break the cron.
  }
  await fireWebhook(input);
  try {
    await pushToCapability("read_console", {
      title: input.type === "site_down" ? "Site down" : "Site recovered",
      body: input.type === "site_down" ? `${input.siteName} is unreachable${input.detail ? `: ${input.detail}` : ""}` : `${input.siteName} is reachable again`,
      data: { type: input.type, siteId: input.siteId, origin: await consoleBaseUrl() },
    });
  } catch {
    // Best-effort: a push never decides anything.
  }
  if (await notifyEmailEnabled("site_health")) {
    try {
      const admins = await getAdminEmails();
      if (admins.length > 0) {
        const m = siteEventEmail({
          type: input.type,
          siteName: input.siteName,
          detail: input.detail,
          consoleUrl: await consoleBaseUrl(),
        });
        await sendMail({ to: admins, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best-effort: email must never break the cron.
    }
  }
}

async function fireWebhook(input: {
  type: NotificationType;
  siteName: string;
  detail: string | null;
}): Promise<void> {
  const url = await resolvedNotificationWebhookUrl();
  if (!url) return;
  const text =
    input.type === "site_down"
      ? `${input.siteName} is down${input.detail ? ": " + input.detail : ""}`
      : `${input.siteName} recovered`;
  const payload = {
    text,
    event: input.type,
    site: input.siteName,
    detail: input.detail ?? undefined,
    at: new Date().toISOString(),
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best-effort: a failed/slow webhook must never break the cron.
  }
}
