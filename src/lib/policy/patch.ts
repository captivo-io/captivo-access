import type { PlatformSettings } from "@/lib/settings/platform";
import type { SessionPolicy } from "@/lib/policy/session-policy";
import type { GuacParams } from "@/lib/gateway/guac-params";

// Applies the Policy page's changed keys to the stored settings. Only the keys
// sent are touched: everything else keeps its stored value, including null
// (which keeps an environment variable or the built-in default in charge).
// Pure + db-free; the route loads, guards and saves.

export const SESSION_KEYS = ["idleTimeoutMinutes", "maxSessionHours", "maxConcurrentPerUser", "requireSecondFactor"] as const;
export type SessionKey = (typeof SESSION_KEYS)[number];

const CLIPBOARD = ["allow", "no_copy", "no_paste", "none"];
const FILE_MODES = ["allow", "no_upload", "no_download", "none"];
const TRI = ["off", "per_resource", "required"];
const LOG_LEVELS = ["debug", "info", "warn", "error"];
const EGRESS = ["strict", "internet", "open"];

type Rule =
  | { kind: "int"; min: number }
  | { kind: "bool" }
  | { kind: "enum"; values: string[] }
  | { kind: "url" }
  | { kind: "text" };

const PLATFORM_RULES: Record<keyof PlatformSettings, Rule> = {
  auditRetentionDays: { kind: "int", min: 0 },
  inviteTtlHours: { kind: "int", min: 1 },
  maxGrantDays: { kind: "int", min: 1 },
  recordingRetentionDays: { kind: "int", min: 1 },
  notificationWebhookUrl: { kind: "url" },
  anchorTsaUrl: { kind: "url" },
  anchorTsaAuth: { kind: "text" },
  vendorIpAllowlist: { kind: "text" },
  displayTimezone: { kind: "text" },
  clipboardDefault: { kind: "enum", values: CLIPBOARD },
  isolatedFileTransferDefault: { kind: "enum", values: FILE_MODES },
  webAppFileTransferDefault: { kind: "enum", values: FILE_MODES },
  keystrokeLoggingMode: { kind: "enum", values: TRI },
  recordingMode: { kind: "enum", values: TRI },
  defaultConnectorLogLevel: { kind: "enum", values: LOG_LEVELS },
  isolatedEgressDefault: { kind: "enum", values: EGRESS },
  recordingConsentRequired: { kind: "bool" },
  watermarkDefault: { kind: "bool" },
  externalAnchorEnabled: { kind: "bool" },
  notifySiteHealth: { kind: "bool" },
  notifyAccessRequests: { kind: "bool" },
  notifyAccessDecisions: { kind: "bool" },
  requireRequestJustification: { kind: "bool" },
};

const SESSION_RULES: Record<SessionKey, Rule> = {
  idleTimeoutMinutes: { kind: "int", min: 1 },
  maxSessionHours: { kind: "int", min: 1 },
  maxConcurrentPerUser: { kind: "int", min: 1 },
  requireSecondFactor: { kind: "bool" },
};

export type PatchError = { error: string; key?: string; invalid?: string[] };

function coerce(rule: Rule, v: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (rule.kind) {
    case "int": {
      if (v === null || v === "") return { ok: true, value: null };
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
      return Number.isInteger(n) && n >= rule.min ? { ok: true, value: n } : { ok: false };
    }
    case "bool":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false };
    case "enum":
      return typeof v === "string" && rule.values.includes(v) ? { ok: true, value: v } : { ok: false };
    case "url": {
      if (v === null || (typeof v === "string" && v.trim() === "")) return { ok: true, value: null };
      if (typeof v !== "string") return { ok: false };
      try {
        const u = new URL(v.trim());
        return u.protocol === "http:" || u.protocol === "https:" ? { ok: true, value: v.trim() } : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    case "text":
      if (v === null) return { ok: true, value: null };
      return typeof v === "string" ? { ok: true, value: v.trim() || null } : { ok: false };
  }
}

const URL_ERRORS: Partial<Record<string, string>> = { notificationWebhookUrl: "invalid_webhook_url", anchorTsaUrl: "anchor_tsa_invalid" };

export function applyPolicyChanges(
  current: { session: SessionPolicy; platform: PlatformSettings },
  changes: Record<string, unknown>,
  ctx: {
    /** Captivo ID owns the display zone: it can't be changed here. */
    zoneManaged: boolean;
    validAllowlist: (raw: string) => string[];
    validZone: (zone: string) => boolean;
    parseGuac: (v: unknown) => GuacParams;
  },
): PatchError | {
  session: SessionPolicy | null;
  platform: PlatformSettings | null;
  guac: GuacParams | null;
  changed: string[];
} {
  const session = { ...current.session };
  const platform = { ...current.platform };
  let guac: GuacParams | null = null;
  let sessionTouched = false;
  let platformTouched = false;
  const changed: string[] = [];

  for (const [key, raw] of Object.entries(changes)) {
    if (key === "guacParamDefaults") {
      guac = ctx.parseGuac(raw);
      changed.push(key);
      continue;
    }
    if (key in SESSION_RULES) {
      const r = coerce(SESSION_RULES[key as SessionKey], raw);
      if (!r.ok) return { error: "invalid_value", key };
      (session as Record<string, unknown>)[key] = key === "requireSecondFactor" ? r.value === true : r.value;
      sessionTouched = true;
      changed.push(key);
      continue;
    }
    if (key in PLATFORM_RULES) {
      const k = key as keyof PlatformSettings;
      if (k === "displayTimezone" && ctx.zoneManaged) continue; // the centre's zone stays
      const r = coerce(PLATFORM_RULES[k], raw);
      if (!r.ok) return { error: URL_ERRORS[k] ?? "invalid_value", key };
      if (k === "vendorIpAllowlist" && typeof r.value === "string") {
        const bad = ctx.validAllowlist(r.value);
        if (bad.length) return { error: "invalid_cidr", key, invalid: bad };
      }
      if (k === "displayTimezone" && typeof r.value === "string" && !ctx.validZone(r.value)) {
        return { error: "invalid_timezone", key };
      }
      (platform as Record<string, unknown>)[k] = r.value;
      platformTouched = true;
      changed.push(k);
      continue;
    }
    return { error: "unknown_setting", key };
  }

  if (platform.externalAnchorEnabled && !platform.anchorTsaUrl) return { error: "anchor_tsa_required", key: "anchorTsaUrl" };
  return { session: sessionTouched ? session : null, platform: platformTouched ? platform : null, guac, changed };
}
