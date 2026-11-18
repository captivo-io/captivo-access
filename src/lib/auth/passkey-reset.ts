import { db } from "@/lib/db";
import { generateToken, hashToken, verifyTokenHash } from "./tokens";
import { resolvedInviteTtlHours } from "@/lib/settings/platform";
import type { Role } from "@/generated/prisma/enums";

// Admin-issued passkey reset: the person's passkeys and console sessions go at
// once, and a one-time link lets them register a new passkey for the same
// account. The link lives as long as an invite (the policy's invite TTL).

/** Why an admin may not reset this person's passkeys, or null when they may. */
export function resetRefusal(
  actorId: string,
  target: { id: string; status: string; centerRole: string | null; role: Role },
): string | null {
  if (target.id === actorId) return "cannot_reset_self";
  // Captivo ID members sign in through their organisation, not a passkey here.
  if (target.centerRole) return "managed_by_center";
  if (target.role === "PLATFORM") return "not_found";
  if (target.status !== "ACTIVE") return "user_disabled";
  return null;
}

export async function resetPasskeys(userId: string, createdById: string): Promise<{ id: string; token: string; removed: number; expiresAt: Date }> {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + (await resolvedInviteTtlHours()) * 3600_000);
  return db.$transaction(async (tx) => {
    const removed = await tx.passkey.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    // Only the newest link works.
    await tx.passkeyReset.deleteMany({ where: { userId, usedAt: null } });
    const r = await tx.passkeyReset.create({ data: { userId, tokenHash, expiresAt, createdById } });
    return { id: r.id, token, removed: removed.count, expiresAt };
  });
}

/** The live reset a token belongs to, with its person; null when unknown, used or expired. */
export async function verifyPasskeyReset(token: string) {
  if (!token) return null;
  // argon2 hashes can't be looked up; scan the few live ones.
  const live = await db.passkeyReset.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() } },
    include: { user: { select: { id: true, email: true, name: true, status: true } } },
  });
  for (const r of live) {
    if (await verifyTokenHash(token, r.tokenHash)) return r;
  }
  return null;
}
