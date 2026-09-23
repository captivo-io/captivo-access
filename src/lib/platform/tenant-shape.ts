// Pure parsing/validation of the JSON-shaped Tenant fields (limits, capabilities)
// and the plan/trial fields. No DB — unit-tested.

// "free": the complimentary tier a new organisation receives from Captivo ID.
// Open-ended on purpose -- it carries no trialEndsAt, so the ops job that
// suspends expired trials never selects it (prisma/rls/bootstrap.sql).
// The same three names Captivo Portal uses, so "Pro" means one thing when a
// customer says it and one thing on an invoice. WHAT a tier includes stays
// product-specific -- Access counts connectors and resources, Portal counts
// concurrent guests -- and that is right: the same step measures different
// things in different products.
export const PLANS = ["free", "pro", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const LIMIT_KEYS = ["maxUsers", "maxSites", "maxConnectors", "maxRecordingRetentionDays"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type TenantLimits = Partial<Record<LimitKey, number>>;

export const CAPABILITY_KEYS = ["recording", "isolated", "gateway", "vault"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
// true/false = forced; absent = deployment default (env flag).
export type TenantCapabilities = Partial<Record<CapabilityKey, boolean>>;

export const LIMIT_LABELS: Record<LimitKey, string> = {
  maxUsers: "Users",
  maxSites: "Resources",
  maxConnectors: "Connectors",
  maxRecordingRetentionDays: "Recording retention (days, max)",
};
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  recording: "Session recording",
  isolated: "Isolated browser sessions",
  gateway: "Native RDP/SSH/VNC gateway",
  vault: "Credential vault",
};

export function isPlan(v: unknown): v is Plan {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v);
}

// Accepts the stored JSON (or a form payload) and returns only well-formed
// entries: positive integers. Unknown keys and junk are dropped, never thrown.
export function parseLimits(v: unknown): TenantLimits {
  const out: TenantLimits = {};
  if (!v || typeof v !== "object") return out;
  for (const k of LIMIT_KEYS) {
    const raw = (v as Record<string, unknown>)[k];
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}

export function parseCapabilities(v: unknown): TenantCapabilities {
  const out: TenantCapabilities = {};
  if (!v || typeof v !== "object") return out;
  for (const k of CAPABILITY_KEYS) {
    const raw = (v as Record<string, unknown>)[k];
    if (typeof raw === "boolean") out[k] = raw;
  }
  return out;
}

// null when nothing is set, so the column stays NULL (= "no overrides").
export function limitsForStorage(l: TenantLimits): TenantLimits | null {
  return Object.keys(l).length ? l : null;
}
export function capabilitiesForStorage(c: TenantCapabilities): TenantCapabilities | null {
  return Object.keys(c).length ? c : null;
}

// Whether `count` (existing) allows one more of `key` under `limits`.
export function withinLimit(limits: TenantLimits, key: LimitKey, count: number): boolean {
  const max = limits[key];
  return max === undefined || count < max;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
