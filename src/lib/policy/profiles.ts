// Named policy profiles (PolicyProfile). A resource that follows a profile has the profile's
// settings WRITTEN onto its own columns whenever either changes, so everything that reads
// a Site keeps reading the same columns: nothing at session time knows about profiles.
// The profile is the source of truth for the settings it governs; the resource form shows
// them read-only while a profile is chosen.

export const PROFILE_CLIPBOARD = ["allow", "no_copy", "no_paste", "none"] as const;
export const PROFILE_FILE_TRANSFER = ["allow", "no_upload", "no_download", "none"] as const;
export const PROFILE_EGRESS = ["internet", "strict", "open"] as const;
export const MAX_PROFILES = 50;
export const MAX_PROFILE_NAME = 48;
export const MAX_EGRESS_HOSTS = 50;

export type ProfileSettings = {
  recordSessions: boolean;
  keystrokeLogging: boolean;
  clipboardMode: string | null;
  watermark: boolean | null;
  fileTransferMode: string | null;
  egressMode: string | null;
  egressHosts: string[];
  requireModerator: boolean;
  passwordCheckout: boolean;
  checkoutMaxMinutes: number;
  commandListId: string | null;
};

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  recordSessions: false, keystrokeLogging: false, clipboardMode: null, watermark: null, fileTransferMode: null,
  egressMode: null, egressHosts: [], requireModerator: false, passwordCheckout: false, checkoutMaxMinutes: 240, commandListId: null,
};

/** The columns of a resource a profile writes, for the kind of resource it is. */
export type SiteColumns = Partial<{
  recordSessions: boolean; keystrokeLogging: boolean; clipboardMode: string | null; watermark: boolean | null; fileTransferMode: string | null;
  egressMode: string | null; egressHosts: string[]; requireModerator: boolean; passwordCheckout: boolean; checkoutMaxMinutes: number; commandListId: string | null;
}>;

type Mode = "TRANSPARENT" | "ISOLATED" | "GATEWAY" | "DATABASE" | "TUNNEL" | "KUBERNETES";

/**
 * What a profile writes onto a resource of this kind. A setting a kind has no use for is left
 * alone (a TCP tunnel is never recorded; only a remote desktop or SSH resource can need a
 * moderator; the network rule is for isolated browsers).
 */
export function columnsFor(p: ProfileSettings, mode: string): SiteColumns {
  const m = mode as Mode;
  const out: SiteColumns = {};
  if (m !== "TUNNEL") {
    out.recordSessions = p.recordSessions;
    out.keystrokeLogging = p.keystrokeLogging;
  }
  if (m === "TRANSPARENT" || m === "ISOLATED" || m === "GATEWAY") {
    out.clipboardMode = p.clipboardMode;
    out.watermark = p.watermark;
  }
  if (m === "TRANSPARENT" || m === "ISOLATED") out.fileTransferMode = p.fileTransferMode;
  if (m === "ISOLATED") {
    out.egressMode = p.egressMode;
    out.egressHosts = p.egressHosts;
  }
  if (m === "GATEWAY") out.requireModerator = p.requireModerator;
  if (m === "GATEWAY" || m === "DATABASE") {
    // A moderated resource cannot hand out its password (checkout.ts), so the two never both apply.
    out.passwordCheckout = p.passwordCheckout && !(m === "GATEWAY" && p.requireModerator);
    out.checkoutMaxMinutes = p.checkoutMaxMinutes;
  }
  if (m === "GATEWAY" || m === "DATABASE" || m === "KUBERNETES") out.commandListId = p.commandListId;
  return out;
}

export type ProfileError =
  | "invalid_name" | "name_too_long" | "invalid_clipboard" | "invalid_file_transfer" | "invalid_egress" | "invalid_egress_hosts"
  | "invalid_checkout_minutes" | "invalid_setting";

const bool = (v: unknown, fallback: boolean): boolean | null => (v === undefined ? fallback : typeof v === "boolean" ? v : null);
const nullableEnum = (v: unknown, allowed: readonly string[], fallback: string | null): string | null | undefined =>
  v === undefined ? fallback : v === null || v === "" ? null : typeof v === "string" && allowed.includes(v) ? v : undefined;

/** A profile from a request body; `base` fills what the body leaves out (an edit sends only what changed). */
export function validateProfile(
  body: Record<string, unknown>,
  base: ProfileSettings & { name: string; description: string | null } = { ...DEFAULT_PROFILE_SETTINGS, name: "", description: null },
): { ok: true; value: ProfileSettings & { name: string; description: string | null } } | { ok: false; error: ProfileError } {
  const name = body.name === undefined ? base.name : typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "invalid_name" };
  if (name.length > MAX_PROFILE_NAME) return { ok: false, error: "name_too_long" };
  const description = body.description === undefined ? base.description : typeof body.description === "string" && body.description.trim() ? body.description.trim().slice(0, 200) : null;

  const recordSessions = bool(body.recordSessions, base.recordSessions);
  const keystrokeLogging = bool(body.keystrokeLogging, base.keystrokeLogging);
  const requireModerator = bool(body.requireModerator, base.requireModerator);
  const passwordCheckout = bool(body.passwordCheckout, base.passwordCheckout);
  if (recordSessions === null || keystrokeLogging === null || requireModerator === null || passwordCheckout === null) return { ok: false, error: "invalid_setting" };
  const watermark = body.watermark === undefined ? base.watermark : body.watermark === null ? null : typeof body.watermark === "boolean" ? body.watermark : undefined;
  if (watermark === undefined) return { ok: false, error: "invalid_setting" };

  const clipboardMode = nullableEnum(body.clipboardMode, PROFILE_CLIPBOARD, base.clipboardMode);
  if (clipboardMode === undefined) return { ok: false, error: "invalid_clipboard" };
  const fileTransferMode = nullableEnum(body.fileTransferMode, PROFILE_FILE_TRANSFER, base.fileTransferMode);
  if (fileTransferMode === undefined) return { ok: false, error: "invalid_file_transfer" };
  const egressMode = nullableEnum(body.egressMode, PROFILE_EGRESS, base.egressMode);
  if (egressMode === undefined) return { ok: false, error: "invalid_egress" };

  let egressHosts = base.egressHosts;
  if (body.egressHosts !== undefined) {
    if (!Array.isArray(body.egressHosts) || body.egressHosts.some((h) => typeof h !== "string")) return { ok: false, error: "invalid_egress_hosts" };
    egressHosts = [...new Set((body.egressHosts as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean))];
    if (egressHosts.length > MAX_EGRESS_HOSTS || egressHosts.some((h) => !/^(\*\.)?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$|^[0-9a-f:.]+$/.test(h))) return { ok: false, error: "invalid_egress_hosts" };
  }

  let checkoutMaxMinutes = base.checkoutMaxMinutes;
  if (body.checkoutMaxMinutes !== undefined) {
    const n = Number(body.checkoutMaxMinutes);
    if (!Number.isInteger(n) || n < 15 || n > 1440) return { ok: false, error: "invalid_checkout_minutes" };
    checkoutMaxMinutes = n;
  }
  const commandListId = body.commandListId === undefined ? base.commandListId : typeof body.commandListId === "string" && body.commandListId ? body.commandListId : null;

  return {
    ok: true,
    value: { name, description, recordSessions, keystrokeLogging, clipboardMode, watermark, fileTransferMode, egressMode, egressHosts, requireModerator, passwordCheckout, checkoutMaxMinutes, commandListId },
  };
}
