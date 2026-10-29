import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";
import { isValidTimeZone } from "@/lib/time/datetime-local";
import { displayTimezoneFromCenter, getPlatformSettings, saveDisplayTimezone } from "@/lib/settings/platform";
import type { IdClaims } from "@/lib/auth/oidc";

/**
 * The workspace's display zone follows its Captivo ID organisation.
 *
 * Captivo ID owns an organisation's time zone (Organization.timeZone). It
 * reaches this workspace pushed at once (POST /api/center/settings) and in
 * the ACCESS grant at every sign-in, which heals a missed push. An
 * organisation that never chose a zone sends none, and the workspace keeps
 * its own setting until the first one arrives; from then on the policy page
 * shows the zone read-only. A person's own override (Preferences) is
 * untouched -- that stays theirs.
 */

/** The current workspace's organisation, when this console is linked to the centre. */
export async function managingOrganisation(): Promise<string | null> {
  const tenantId = currentTenantId();
  if (tenantId === PLATFORM_TENANT_ID || !captivoAccountUrl()) return null;
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { captivoOrgId: true } });
  return t?.captivoOrgId ?? null;
}

/** Whether the organisation's zone, not this console, decides the display zone. */
export async function timeZoneManaged(): Promise<boolean> {
  return (await managingOrganisation()) !== null && (await displayTimezoneFromCenter());
}

/** The zone the ACCESS grant for `org` carries, or null. */
export function grantTimeZone(claims: IdClaims, org: string): string | null {
  const grants = claims?.captivo?.grants;
  if (!Array.isArray(grants)) return null;
  for (const g of grants) {
    if (!g || typeof g !== "object") continue;
    const rec = g as Record<string, unknown>;
    if (rec.product !== "ACCESS" || rec.org !== org) continue;
    return typeof rec.timeZone === "string" && isValidTimeZone(rec.timeZone) ? rec.timeZone : null;
  }
  return null;
}

/** Write the centre's zone as this workspace's display zone; whether anything changed. */
export async function applyCenterTimeZone(zone: string): Promise<boolean> {
  if (!isValidTimeZone(zone)) return false;
  if ((await getPlatformSettings()).displayTimezone === zone && (await displayTimezoneFromCenter())) return false;
  await saveDisplayTimezone(zone);
  return true;
}
