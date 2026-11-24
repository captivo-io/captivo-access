import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Session invites: the link an admin sends, and the pass the guest's browser
// keeps once they have signed in. Both carry a random secret of which only a
// SHA-256 is stored -- 256 random bits need no slow hash. Pure: the routes and
// lib/live/invites.ts do the database work.

/** The guest's pass. Host-only (no Domain): it belongs to this console. */
export const GUEST_COOKIE = "ca_guest";

/** How many people one session can have invited and not yet removed. */
export const MAX_GUESTS_PER_SESSION = 5;

/** "Until the session ends" still stops here, as every session does at last. */
export const SESSION_LONG_STOP_HOURS = 12;

export const INVITE_DURATIONS = ["15m", "1h", "session"] as const;
export type InviteDuration = (typeof INVITE_DURATIONS)[number];

export function isInviteDuration(v: unknown): v is InviteDuration {
  return typeof v === "string" && (INVITE_DURATIONS as readonly string[]).includes(v);
}

export function inviteExpiry(d: InviteDuration, now: Date): { expiresAt: Date; untilSessionEnds: boolean } {
  const ms = d === "15m" ? 15 * 60_000 : d === "1h" ? 60 * 60_000 : SESSION_LONG_STOP_HOURS * 3_600_000;
  return { expiresAt: new Date(now.getTime() + ms), untilSessionEnds: d === "session" };
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, hash: string | null | undefined): boolean {
  if (!hash) return false;
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const ID = /^[a-z0-9]{10,40}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;

/** The link's last path segment: `<invite id>.<secret>`. */
export function linkToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseLinkToken(token: string | null | undefined): { id: string; secret: string } | null {
  const parts = (token ?? "").split(".");
  if (parts.length !== 2 || !ID.test(parts[0]) || !SECRET.test(parts[1])) return null;
  return { id: parts[0], secret: parts[1] };
}

/**
 * The pass: `<tenant>.<invite id>.<secret>`. The tenant is in it so the data
 * plane's question about it can be answered in that workspace's scope; it is
 * not a secret, and the invite must still be found there and match.
 */
export function guestPass(tenantId: string, id: string, secret: string): string {
  return `${tenantId}.${id}.${secret}`;
}

export function parseGuestPass(value: string | null | undefined): { tenantId: string; id: string; secret: string } | null {
  const parts = (value ?? "").split(".");
  if (parts.length !== 3 || !TENANT.test(parts[0]) || !ID.test(parts[1]) || !SECRET.test(parts[2])) return null;
  return { tenantId: parts[0], id: parts[1], secret: parts[2] };
}

/** The data plane's viewer id for a guest: control is held under it. */
export function guestViewerId(inviteId: string): string {
  return `guest:${inviteId}`;
}

export function isGuestViewerId(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith("guest:");
}

export type InviteStatus = "waiting" | "joined" | "expired" | "removed";

export function inviteStatus(row: { joinedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): InviteStatus {
  if (row.revokedAt) return "removed";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return row.joinedAt ? "joined" : "waiting";
}

/**
 * Sessions a guest can be invited into: those whose view the data plane
 * gates itself -- a browser session through guacd, and recorded native SSH
 * and RDP. An isolated browser's view-only is a setting of the viewer's own
 * page (fine for an admin, not for someone from outside), database sessions
 * have no screen, and an unrecorded native session can't be watched at all.
 */
export function invitableSession(s: { kind: string; native?: boolean; watchable?: boolean }): boolean {
  return s.kind === "gateway" && (!s.native || s.watchable === true);
}
