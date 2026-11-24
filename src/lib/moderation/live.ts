import { can } from "@/lib/auth/roles";
import { findOwnSession } from "@/lib/dataplane/client";
import type { Role } from "@/generated/prisma/enums";

/**
 * Whether this console user may message, take control of or end this live
 * session: an admin always; the moderator of a moderated session too (an
 * operator moderates with those three only).
 */
export async function mayActOnSession(user: { id: string; role: Role }, sessionId: string): Promise<boolean> {
  if (can(user.role, "configure")) return true;
  const s = await findOwnSession(sessionId);
  return !!s?.moderation && s.moderation.moderatorId === user.id && s.userId !== user.id;
}
