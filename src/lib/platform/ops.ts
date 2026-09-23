// Daily platform maintenance (Cloud): purge tenants deleted > PURGE_AFTER_DAYS
// ago, suspend expired trials, and email the ops digest when there are alerts.
// Runs under the platform tenant scope (audit rows land in the platform chain).
import { purgeCandidates } from "@/lib/platform/sql";
import { purgeTenant, setTenantStatus, getTenant, PURGE_AFTER_DAYS } from "@/lib/platform/tenants";
import { forceLogoutTenant } from "@/lib/platform/tenant-admin";
import { recordPlatformAction } from "@/lib/platform/audit";
import { platformSnapshot } from "@/lib/platform/overview";
import { getPlatformConfig } from "@/lib/platform/config";
import { sendMail } from "@/lib/email/mailer";
import { consoleDomain } from "@/lib/tenant/console-domain";

const SYSTEM = { id: "system", email: "platform-ops@system" };

export interface OpsResult { purged: string[]; alerts: number; digestSent: boolean }

export async function runPlatformOps(): Promise<OpsResult> {
  const purged: string[] = [];
  for (const id of await purgeCandidates(PURGE_AFTER_DAYS)) {
    const t = await getTenant(id);
    await recordPlatformAction({ actor: SYSTEM, action: "platform.tenant.purge", tenant: null, targetType: "tenant", targetId: id, summary: `Purged tenant ${t?.slug ?? id} (${PURGE_AFTER_DAYS} days after deletion)`, metadata: { slug: t?.slug, name: t?.name } });
    await purgeTenant(id);
    purged.push(t?.slug ?? id);
  }

  const [snap, config] = await Promise.all([platformSnapshot(), getPlatformConfig()]);
  const actionable = snap.alerts.filter((a) => a.level !== "info");
  let digestSent = false;
  if (config.opsEmail && (actionable.length > 0 || purged.length > 0)) {
    const domain = consoleDomain();
    const link = domain ? `https://platform.${domain}/platform` : "";
    const lines = [
      ...actionable.map((a) => `[${a.level.toUpperCase()}] ${a.tenant ? `${a.tenant.name} (${a.tenant.slug}): ` : ""}${a.text}`),
      ...purged.map((s) => `[INFO] Purged tenant ${s}`),
    ];
    const text = `Captivo platform digest — ${new Date().toISOString().slice(0, 10)}\n\n${lines.join("\n")}\n\n${link}`;
    const html = `<p><b>Captivo platform digest</b> — ${new Date().toISOString().slice(0, 10)}</p><ul>${lines.map((l) => `<li>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`).join("")}</ul>${link ? `<p><a href="${link}">Open the platform console</a></p>` : ""}`;
    digestSent = (await sendMail({ to: config.opsEmail, subject: `[Captivo platform] ${actionable.length} alert${actionable.length === 1 ? "" : "s"}`, html, text })).sent;
  }
  return { purged, alerts: actionable.length, digestSent };
}
