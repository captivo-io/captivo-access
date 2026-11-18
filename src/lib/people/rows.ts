import type { Role } from "@/generated/prisma/enums";

// Shapes the People page passes to the browser. Pure + db-free.

export type UserSource = "local" | "directory" | "captivo";

export interface PersonRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  role: Role;
  status: "ACTIVE" | "DISABLED";
  passkeys: number;
  source: UserSource;
  /** Latest console or passkey activity we know of; there is no separate last-login field. */
  lastActive: string | null;
  isSelf: boolean;
  /** Roles this user may be given (Captivo ID members only within their organisation role). */
  roles: Role[];
  canToggle: boolean;
  canDelete: boolean;
  /** Remove their passkeys and issue a one-time link for a new one. */
  canReset: boolean;
}

export type InviteState = "pending" | "used" | "expired";

export interface InviteRowJSON {
  id: string;
  name: string;
  email: string;
  company: string | null;
  role: Role;
  state: InviteState;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  invitedBy: string | null;
}

export interface ConsoleSessionRow {
  id: string;
  userName: string;
  userEmail: string;
  ip: string | null;
  userAgent: string | null;
  /** "Chrome · macOS", or null when the user agent says nothing useful. */
  device: string | null;
  mobile: boolean;
  signIn: string;
  startedAt: string;
  lastSeenAt: string;
  current: boolean;
}

export function inviteState(inv: { usedAt: Date | null; expiresAt: Date }, now: Date): InviteState {
  if (inv.usedAt) return "used";
  return inv.expiresAt < now ? "expired" : "pending";
}

export function userSource(u: { centerRole: string | null; directoryManaged: boolean }): UserSource {
  if (u.centerRole) return "captivo";
  return u.directoryManaged ? "directory" : "local";
}

/** The later of the given dates, as ISO. */
export function latest(...ds: (Date | null | undefined)[]): string | null {
  const t = Math.max(0, ...ds.map((d) => (d ? d.getTime() : 0)));
  return t > 0 ? new Date(t).toISOString() : null;
}

/** Phones and tablets, from the user agent. */
export function isMobileAgent(ua: string | null | undefined): boolean {
  return !!ua && /iPhone|iPad|Android|Mobile/.test(ua);
}

/** Invite link lifetimes offered in the dialog (hours), with the policy's own added when it differs. */
export function inviteTtlChoices(policyHours: number): number[] {
  const base = [24, 72, 168];
  return base.includes(policyHours) ? base : [...base, policyHours].sort((a, b) => a - b);
}

export function ttlLabel(h: number): string {
  if (h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? "24 hours" : `${d} days`;
  }
  return `${h} hours`;
}
