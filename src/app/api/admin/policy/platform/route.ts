import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { getPlatformSettings, savePlatformSettings, saveGuacParamDefaults, CLIPBOARD_MODES } from "@/lib/settings/platform";
import { parseGuacParams } from "@/lib/gateway/guac-params";
import { validateAllowlist } from "@/lib/net/cidr";
import { withTenantRoute } from "@/lib/tenant/request";
import { isValidTimeZone } from "@/lib/time/datetime-local";
import { managingOrganisation } from "@/lib/tenant/center-time-zone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toIntMin(v: unknown, min: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min ? Math.floor(n) : null;
}

function toWebhook(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (typeof v !== "string" || v.trim() === "") return { ok: true, value: null };
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false };
    return { ok: true, value: v.trim() };
  } catch {
    return { ok: false };
  }
}

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  const webhook = toWebhook(body.notificationWebhookUrl);
  if (!webhook.ok) return NextResponse.json({ error: "invalid_webhook_url" }, { status: 400 });

  const rawAllow = typeof body.vendorIpAllowlist === "string" ? body.vendorIpAllowlist : "";
  const badCidrs = validateAllowlist(rawAllow);
  if (badCidrs.length) return NextResponse.json({ error: "invalid_cidr", invalid: badCidrs }, { status: 400 });
  // Same check as a person's own zone (api/settings/timezone): a name Intl does not
  // know would make every LocalTime on the console throw a RangeError.
  const zoneManaged = (await managingOrganisation()) !== null;
  if (!zoneManaged && typeof body.displayTimezone === "string" && body.displayTimezone && !isValidTimeZone(body.displayTimezone)) {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }

  const anchorEnabled = body.externalAnchorEnabled === true;
  const anchorTsaUrl = typeof body.anchorTsaUrl === "string" ? body.anchorTsaUrl.trim() : "";
  const anchorTsaAuth = typeof body.anchorTsaAuth === "string" ? body.anchorTsaAuth.trim() : "";
  if (anchorEnabled && anchorTsaUrl === "") {
    return NextResponse.json({ error: "anchor_tsa_required" }, { status: 400 });
  }
  if (anchorTsaUrl !== "") {
    try {
      const u = new URL(anchorTsaUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    } catch {
      return NextResponse.json({ error: "anchor_tsa_invalid" }, { status: 400 });
    }
  }

  await savePlatformSettings({
    auditRetentionDays: toIntMin(body.auditRetentionDays, 0),
    inviteTtlHours: toIntMin(body.inviteTtlHours, 1),
    notificationWebhookUrl: webhook.value,
    vendorIpAllowlist: rawAllow.trim() || null,
    maxGrantDays: toIntMin(body.maxGrantDays, 1),
    recordingConsentRequired: body.recordingConsentRequired === true,
    watermarkDefault: body.watermarkDefault === true,
    clipboardDefault: typeof body.clipboardDefault === "string" && CLIPBOARD_MODES.includes(body.clipboardDefault)
      ? body.clipboardDefault
      : null,
    // Linked to a Captivo ID organisation: the zone is the centre's and the
    // field is read-only; whatever was posted, the current one is kept.
    displayTimezone: zoneManaged
      ? (await getPlatformSettings()).displayTimezone
      : typeof body.displayTimezone === "string" && body.displayTimezone ? body.displayTimezone : null,
    recordingRetentionDays: toIntMin(body.recordingRetentionDays, 1),
    defaultConnectorLogLevel: ["debug", "info", "warn", "error"].includes(body.defaultConnectorLogLevel)
      ? (body.defaultConnectorLogLevel as string)
      : "info",
    externalAnchorEnabled: anchorEnabled,
    anchorTsaUrl: anchorTsaUrl || null,
    anchorTsaAuth: anchorTsaAuth || null,
    // Default-on coercion: anything not explicitly false persists as true.
    notifySiteHealth: body.notifySiteHealth !== false,
    notifyAccessRequests: body.notifyAccessRequests !== false,
    notifyAccessDecisions: body.notifyAccessDecisions !== false,
    requireRequestJustification: body.requireRequestJustification !== false,
    keystrokeLoggingMode: ["off", "per_resource", "required"].includes(body.keystrokeLoggingMode)
      ? (body.keystrokeLoggingMode as string)
      : "per_resource",
    recordingMode: ["off", "per_resource", "required"].includes(body.recordingMode)
      ? (body.recordingMode as string)
      : "per_resource",
  });
  await saveGuacParamDefaults(parseGuacParams(body.guacParamDefaults));
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.platform_update",
    summary: "Updated platform settings",
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
