import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { parseGuacParams, type GuacParams } from "@/lib/gateway/guac-params";

// Tenant-wide operational settings, editable from /admin/policy. Each was
// previously env-only; the resolvers below read the DB value first, fall back
// to the old env var, then a hard default — so a set env var still works but is
// no longer required, and the UI value wins when present.

export interface PlatformSettings {
  auditRetentionDays: number | null;
  inviteTtlHours: number | null;
  notificationWebhookUrl: string | null;
  vendorIpAllowlist: string | null;
  maxGrantDays: number | null;
  recordingConsentRequired: boolean | null;
  watermarkDefault: boolean | null;
  clipboardDefault: string | null;
  displayTimezone: string | null;
  recordingRetentionDays: number | null;
  defaultConnectorLogLevel: string | null;
  externalAnchorEnabled: boolean | null;
  anchorTsaUrl: string | null;
  anchorTsaAuth: string | null;
  notifySiteHealth: boolean | null;
  notifyAccessRequests: boolean | null;
  notifyAccessDecisions: boolean | null;
  requireRequestJustification: boolean | null;
  keystrokeLoggingMode: string | null;
  recordingMode: string | null;
}

const EMPTY: PlatformSettings = {
  auditRetentionDays: null,
  inviteTtlHours: null,
  notificationWebhookUrl: null,
  vendorIpAllowlist: null,
  maxGrantDays: null,
  recordingConsentRequired: null,
  watermarkDefault: null,
  clipboardDefault: null,
  displayTimezone: null,
  recordingRetentionDays: null,
  defaultConnectorLogLevel: null,
  externalAnchorEnabled: null,
  anchorTsaUrl: null,
  anchorTsaAuth: null,
  notifySiteHealth: null,
  notifyAccessRequests: null,
  notifyAccessDecisions: null,
  requireRequestJustification: null,
  keystrokeLoggingMode: null,
  recordingMode: null,
};

// Keyed by tenant id: a single un-keyed slot would let one tenant's settings
// leak into another's reads for up to the TTL below (multi-tenant only — every
// call shares one Node process across concurrent tenants; self-host has just
// the "default" tenant, so this was latent there).
const cache = new Map<string, { s: PlatformSettings; at: number }>();

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const tid = currentTenantId();
  const hit = cache.get(tid);
  if (hit && Date.now() - hit.at < 30_000) return hit.s;
  let c;
  try {
    c = await db.platformSettings.findUnique({ where: { tenantId: currentTenantId() } });
  } catch {
    return EMPTY; // table missing / DB down -> resolvers fall back to env/default
  }
  const s: PlatformSettings = {
    auditRetentionDays: c?.auditRetentionDays ?? null,
    inviteTtlHours: c?.inviteTtlHours ?? null,
    notificationWebhookUrl: c?.notificationWebhookUrl ?? null,
    vendorIpAllowlist: c?.vendorIpAllowlist ?? null,
    maxGrantDays: c?.maxGrantDays ?? null,
    recordingConsentRequired: c?.recordingConsentRequired ?? null,
    watermarkDefault: c?.watermarkDefault ?? null,
    clipboardDefault: c?.clipboardDefault ?? null,
    displayTimezone: c?.displayTimezone ?? null,
    recordingRetentionDays: c?.recordingRetentionDays ?? null,
    defaultConnectorLogLevel: c?.defaultConnectorLogLevel ?? null,
    externalAnchorEnabled: c?.externalAnchorEnabled ?? null,
    anchorTsaUrl: c?.anchorTsaUrl ?? null,
    anchorTsaAuth: c?.anchorTsaAuth ?? null,
    notifySiteHealth: c?.notifySiteHealth ?? null,
    notifyAccessRequests: c?.notifyAccessRequests ?? null,
    notifyAccessDecisions: c?.notifyAccessDecisions ?? null,
    requireRequestJustification: c?.requireRequestJustification ?? null,
    keystrokeLoggingMode: c?.keystrokeLoggingMode ?? null,
    recordingMode: c?.recordingMode ?? null,
  };
  cache.set(tid, { s, at: Date.now() });
  return s;
}

export async function savePlatformSettings(input: PlatformSettings): Promise<void> {
  await db.platformSettings.upsert({
    where: { tenantId: currentTenantId() },
    create: { tenantId: currentTenantId(), ...input },
    update: { ...input },
  });
  cache.delete(currentTenantId());
}

/** Only the display zone: what Captivo ID pushes (lib/tenant/center-time-zone.ts). */
export async function saveDisplayTimezone(zone: string): Promise<void> {
  await db.platformSettings.upsert({
    where: { tenantId: currentTenantId() },
    create: { tenantId: currentTenantId(), displayTimezone: zone },
    update: { displayTimezone: zone },
  });
  cache.delete(currentTenantId());
}

// Global default Guacamole connection params (curated allowlist). Kept out of the
// generic PlatformSettings interface/save to avoid Prisma Json-null friction.
export async function resolvedGuacParamDefaults(): Promise<GuacParams> {
  try {
    const c = await db.platformSettings.findUnique({ where: { tenantId: currentTenantId() }, select: { guacParamDefaults: true } });
    return parseGuacParams(c?.guacParamDefaults);
  } catch {
    return {};
  }
}

export async function saveGuacParamDefaults(p: GuacParams): Promise<void> {
  const value = parseGuacParams(p) as Prisma.InputJsonValue;
  await db.platformSettings.upsert({
    where: { tenantId: currentTenantId() },
    create: { tenantId: currentTenantId(), guacParamDefaults: value },
    update: { guacParamDefaults: value },
  });
  cache.delete(currentTenantId());
}

function envInt(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Resolved values: DB → env → default.
export async function resolvedAuditRetentionDays(): Promise<number> {
  const s = await getPlatformSettings();
  const v = s.auditRetentionDays ?? envInt("AUDIT_RETENTION_DAYS");
  return v !== null && v >= 0 ? v : 730;
}

export async function resolvedInviteTtlHours(): Promise<number> {
  const s = await getPlatformSettings();
  const v = s.inviteTtlHours ?? envInt("INVITE_TTL_HOURS");
  return v !== null && v > 0 ? v : 48;
}

export async function resolvedNotificationWebhookUrl(): Promise<string> {
  const s = await getPlatformSettings();
  return (s.notificationWebhookUrl ?? process.env.NOTIFICATION_WEBHOOK_URL ?? "").trim();
}

// Raw vendor source-IP allowlist (CIDRs/IPs). Empty = no restriction. No env
// fallback — this is a new, UI-only control.
export async function resolvedVendorIpAllowlist(): Promise<string> {
  const s = await getPlatformSettings();
  return (s.vendorIpAllowlist ?? "").trim();
}

// Max grant duration in days; 0 = no cap. UI-only (no env).
export async function resolvedMaxGrantDays(): Promise<number> {
  const s = await getPlatformSettings();
  return s.maxGrantDays && s.maxGrantDays > 0 ? s.maxGrantDays : 0;
}

// Recording consent gate: DB value first, else the RECORDING_CONSENT_REQUIRED
// env (1/true/on/yes), else false.
export async function resolvedRecordingConsentRequired(): Promise<boolean> {
  const s = await getPlatformSettings();
  if (s.recordingConsentRequired !== null) return s.recordingConsentRequired;
  const v = process.env.RECORDING_CONSENT_REQUIRED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

// Isolated-session screen watermark default: DB value first, else the
// WATERMARK_DEFAULT env (1/true/on/yes), else false.
export async function resolvedWatermarkDefault(): Promise<boolean> {
  const s = await getPlatformSettings();
  if (s.watermarkDefault !== null) return s.watermarkDefault;
  const v = process.env.WATERMARK_DEFAULT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export const CLIPBOARD_MODES = ["allow", "no_copy", "no_paste", "none"];

// Coerce a stored clipboard default to a concrete mode; unknown/null → "allow".
export function coerceClipboardDefault(v: string | null): string {
  return v && CLIPBOARD_MODES.includes(v) ? v : "allow";
}

// Tenant-wide clipboard default for resources that inherit (Site.clipboardMode
// is null). DB value if valid, else "allow". No env fallback (UI-only control).
export async function resolvedClipboardDefault(): Promise<string> {
  const s = await getPlatformSettings();
  return coerceClipboardDefault(s.clipboardDefault);
}

// Recording retention in days; 0 = keep forever. UI-only (no env).
export async function resolvedRecordingRetentionDays(): Promise<number> {
  const s = await getPlatformSettings();
  const own = s.recordingRetentionDays && s.recordingRetentionDays > 0 ? s.recordingRetentionDays : 0;
  // Cloud: the platform may cap a tenant's retention (0 = forever → the cap).
  const { capRecordingRetention } = await import("@/lib/tenant/envelope");
  return capRecordingRetention(own);
}

const LOG_LEVELS = ["debug", "info", "warn", "error"];

// Fleet default connector log level — applied to connectors whose own level is
// null ("use default"). Falls back to info.
export async function resolvedDefaultConnectorLogLevel(): Promise<string> {
  const s = await getPlatformSettings();
  const v = s.defaultConnectorLogLevel;
  return v && LOG_LEVELS.includes(v) ? v : "info";
}

// The level actually pushed to a connector: its own explicit level, else the
// fleet default. Central so the status route and live push agree.
export async function resolvedConnectorLogLevel(own: string | null): Promise<string> {
  if (own && LOG_LEVELS.includes(own)) return own;
  return resolvedDefaultConnectorLogLevel();
}

// External anchor (RFC 3161). Opt-in, off by default; no env fallback, no bundled TSA.
export async function resolvedExternalAnchorEnabled(): Promise<boolean> {
  const s = await getPlatformSettings();
  return s.externalAnchorEnabled === true;
}

// Default ON: a justification is required unless an admin explicitly turns it off.
export async function resolvedRequireRequestJustification(): Promise<boolean> {
  const s = await getPlatformSettings();
  return s.requireRequestJustification !== false;
}

export type KeystrokeMode = "off" | "per_resource" | "required";
const KEYSTROKE_MODES: KeystrokeMode[] = ["off", "per_resource", "required"];

// Tenant-wide keystroke-logging mode: DB value if valid, else per_resource.
// No env fallback (UI-only control).
export async function resolvedKeystrokeLoggingMode(): Promise<KeystrokeMode> {
  const s = await getPlatformSettings();
  const v = s.keystrokeLoggingMode;
  return v && (KEYSTROKE_MODES as string[]).includes(v) ? (v as KeystrokeMode) : "per_resource";
}

export const RECORDING_MODES = ["off", "per_resource", "required"] as const;
export async function resolvedRecordingMode(): Promise<string> {
  // Cloud: a tenant whose recording capability is switched off by the platform
  // records nothing, whatever its own policy says.
  const { capabilityAllowed } = await import("@/lib/tenant/envelope");
  if (!(await capabilityAllowed("recording"))) return "off";
  const s = await getPlatformSettings();
  if (s.recordingMode && (RECORDING_MODES as readonly string[]).includes(s.recordingMode)) return s.recordingMode;
  const v = process.env.RECORDING_MODE?.trim().toLowerCase();
  if (v && (RECORDING_MODES as readonly string[]).includes(v)) return v;
  return "per_resource";
}

export async function resolvedAnchorTsaUrl(): Promise<string> {
  const s = await getPlatformSettings();
  return (s.anchorTsaUrl ?? "").trim();
}

export async function resolvedAnchorTsaAuth(): Promise<string> {
  const s = await getPlatformSettings();
  return (s.anchorTsaAuth ?? "").trim();
}
