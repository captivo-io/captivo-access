import { base } from "@/lib/db";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { pushToPlatform } from "@/lib/mobile/push";
import { platformSnapshot, type PlatformAlert } from "@/lib/platform/overview";

/**
 * Tells the platform operators' phones about an alert once, when it first
 * appears. The keys already told are kept on PlatformConfig; an alert that
 * clears drops out of the set, so if it comes back it is told again.
 *
 * Numbers are left out of the key: "audit-retention last ran 27h ago" is the
 * same alert an hour later, not a new one.
 */
export function alertKey(a: PlatformAlert): string {
  return `${a.kind}|${a.tenant?.id ?? ""}|${a.text.replace(/\d+/g, "#")}`;
}

export function freshAlerts(alerts: PlatformAlert[], told: string[]): { fresh: PlatformAlert[]; keys: string[] } {
  const actionable = alerts.filter((a) => a.level !== "info");
  const known = new Set(told);
  const keys = [...new Set(actionable.map(alertKey))];
  return { fresh: actionable.filter((a) => !known.has(alertKey(a))), keys };
}

export function alertPush(fresh: PlatformAlert[]) {
  const one = fresh[0];
  return {
    title: fresh.length === 1 ? (one.level === "danger" ? "Platform alert" : "Platform warning") : `${fresh.length} new platform alerts`,
    body: fresh.length === 1 ? `${one.tenant ? `${one.tenant.name}: ` : ""}${one.text}` : fresh.slice(0, 3).map((a) => a.tenant?.name ?? a.kind).join(", "),
    data: { type: "platform_alert" },
  };
}

/** Runs after each site-health pass. Never throws. */
export async function notifyPlatformAlerts(): Promise<number> {
  if (!multiTenantEnabled()) return 0;
  try {
    const [{ alerts }, row] = await Promise.all([
      platformSnapshot(),
      base.platformConfig.findUnique({ where: { id: "platform" }, select: { notifiedAlerts: true } }),
    ]);
    const { fresh, keys } = freshAlerts(alerts, row?.notifiedAlerts ?? []);
    await base.platformConfig.upsert({ where: { id: "platform" }, update: { notifiedAlerts: keys }, create: { id: "platform", notifiedAlerts: keys } });
    if (fresh.length) await pushToPlatform(alertPush(fresh));
    return fresh.length;
  } catch (err) {
    console.warn("[platform] alert push failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}
