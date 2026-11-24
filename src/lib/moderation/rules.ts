import type { Role } from "@/generated/prisma/enums";

// Moderated sessions (four eyes): a resource that needs a moderator starts a
// session only once a moderator admits it, and the user's input passes only
// while that moderator watches (dataplane/moderation.go). Pure rules; the
// store is ./requests.ts.

/** A request waits this long for a moderator. */
export const MODERATION_WAIT_MS = 10 * 60_000;
/** Once admitted, the session must start within this. */
export const ADMISSION_MS = 2 * 60_000;

export type ModerationKind = "browser" | "ssh";
export type ModerationStatus = "waiting" | "admitted" | "started" | "declined" | "cancelled" | "expired";
export type ModeratorRoles = "admins" | "admins_operators";

export function moderationRequired(site: { accessMode: string; requireModerator: boolean }): boolean {
  return site.accessMode === "GATEWAY" && site.requireModerator;
}

export function canModerate(role: Role, roles: ModeratorRoles): boolean {
  return role === "ADMIN" || (roles === "admins_operators" && role === "OPERATOR");
}

/** The roles that may moderate, for finding who to tell. */
export function moderatorRoleList(roles: ModeratorRoles): Role[] {
  return roles === "admins" ? ["ADMIN"] : ["ADMIN", "OPERATOR"];
}

/** A stored request's status now: waiting and admitted ones run out. */
export function statusOf(r: { status: string; requestedAt: Date; decidedAt: Date | null }, now: Date): ModerationStatus {
  if (r.status === "waiting" && now.getTime() - r.requestedAt.getTime() > MODERATION_WAIT_MS) return "expired";
  if (r.status === "admitted" && (!r.decidedAt || now.getTime() - r.decidedAt.getTime() > ADMISSION_MS)) return "expired";
  return (["waiting", "admitted", "started", "declined", "cancelled"] as const).find((s) => s === r.status) ?? "expired";
}

/**
 * Why a moderated resource can't be opened this way: a moderator must be able
 * to watch, so only browser sessions and recorded native SSH qualify.
 */
export function moderationBlock(kind: "native_rdp" | "native_ssh", recorded: boolean): "moderator_browser_only" | "moderator_needs_recording" | null {
  if (kind === "native_rdp") return "moderator_browser_only";
  return recorded ? null : "moderator_needs_recording";
}
