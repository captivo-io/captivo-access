import { isValidTimeZone } from "@/lib/time/datetime-local";
import { base } from "@/lib/db";
import type { PlatformSettings } from "@/lib/settings/platform";

// Platform-wide configuration (Cloud): one row, read by every tenant request
// (announcement banner, signup toggle, SMTP fallback) and written only from the
// platform console. Not tenant-scoped, so it goes through `base`. Cached briefly
// — a banner change may take up to CACHE_MS to show on tenant consoles.
export type AnnouncementLevel = "info" | "warn" | "danger";
export interface PlatformConfig {
  announcementText: string | null;
  announcementLevel: AnnouncementLevel;
  announcementUntil: Date | null;
  newTenantDefaults: Partial<NewTenantDefaults> | null;
  opsEmail: string | null;
  smtpFallback: boolean;
  signupEnabled: boolean;
  updatedAt: Date | null;
}
// The PlatformSettings subset a platform operator may preset for new tenants.
export type NewTenantDefaults = Pick<PlatformSettings, "recordingMode" | "keystrokeLoggingMode" | "auditRetentionDays" | "recordingRetentionDays" | "maxGrantDays" | "requireRequestJustification" | "displayTimezone">;
export const NEW_TENANT_DEFAULT_KEYS: (keyof NewTenantDefaults)[] = ["recordingMode", "keystrokeLoggingMode", "auditRetentionDays", "recordingRetentionDays", "maxGrantDays", "requireRequestJustification", "displayTimezone"];

export const EMPTY_CONFIG: PlatformConfig = { announcementText: null, announcementLevel: "info", announcementUntil: null, newTenantDefaults: null, opsEmail: null, smtpFallback: false, signupEnabled: false, updatedAt: null };

const CACHE_MS = 15_000;
let cache: { c: PlatformConfig; at: number } | null = null;

function level(v: string | null | undefined): AnnouncementLevel {
  return v === "warn" || v === "danger" ? v : "info";
}

export function parseNewTenantDefaults(v: unknown): Partial<NewTenantDefaults> | null {
  if (!v || typeof v !== "object") return null;
  const out: Partial<NewTenantDefaults> = {};
  const o = v as Record<string, unknown>;
  if (typeof o.recordingMode === "string" && o.recordingMode) out.recordingMode = o.recordingMode;
  if (typeof o.keystrokeLoggingMode === "string" && o.keystrokeLoggingMode) out.keystrokeLoggingMode = o.keystrokeLoggingMode;
  for (const k of ["auditRetentionDays", "recordingRetentionDays", "maxGrantDays"] as const) {
    const n = typeof o[k] === "string" && (o[k] as string).trim() !== "" ? Number(o[k]) : o[k];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) out[k] = n;
  }
  if (typeof o.requireRequestJustification === "boolean") out.requireRequestJustification = o.requireRequestJustification;
  if (typeof o.displayTimezone === "string" && o.displayTimezone && isValidTimeZone(o.displayTimezone)) out.displayTimezone = o.displayTimezone;
  return Object.keys(out).length ? out : null;
}

export async function getPlatformConfig(): Promise<PlatformConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.c;
  let row;
  try {
    row = await base.platformConfig.findUnique({ where: { id: "platform" } });
  } catch {
    return EMPTY_CONFIG; // table missing (pre-migration) → defaults, never throw on a tenant request
  }
  const c: PlatformConfig = row
    ? {
        announcementText: row.announcementText?.trim() || null,
        announcementLevel: level(row.announcementLevel),
        announcementUntil: row.announcementUntil,
        newTenantDefaults: parseNewTenantDefaults(row.newTenantDefaults),
        opsEmail: row.opsEmail?.trim() || null,
        smtpFallback: row.smtpFallback,
        signupEnabled: row.signupEnabled,
        updatedAt: row.updatedAt,
      }
    : EMPTY_CONFIG;
  cache = { c, at: Date.now() };
  return c;
}

export async function savePlatformConfig(input: Omit<PlatformConfig, "updatedAt">): Promise<void> {
  const data = {
    announcementText: input.announcementText?.trim() || null,
    announcementLevel: level(input.announcementLevel),
    announcementUntil: input.announcementUntil,
    newTenantDefaults: input.newTenantDefaults ?? undefined,
    opsEmail: input.opsEmail?.trim() || null,
    smtpFallback: input.smtpFallback,
    signupEnabled: input.signupEnabled,
  };
  await base.platformConfig.upsert({
    where: { id: "platform" },
    create: { id: "platform", ...data, newTenantDefaults: input.newTenantDefaults ?? undefined },
    update: { ...data, newTenantDefaults: input.newTenantDefaults === null ? { set: null } as never : data.newTenantDefaults },
  });
  cache = null;
}

// The announcement to show on tenant consoles right now (null when none / expired).
export function activeAnnouncement(c: PlatformConfig, now: Date = new Date()): { text: string; level: AnnouncementLevel } | null {
  if (!c.announcementText) return null;
  if (c.announcementUntil && c.announcementUntil.getTime() < now.getTime()) return null;
  return { text: c.announcementText, level: c.announcementLevel };
}

export function newTenantDefaultsFrom(c: PlatformConfig): Partial<PlatformSettings> | null {
  return c.newTenantDefaults;
}
