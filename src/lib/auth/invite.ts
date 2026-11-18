import { db } from "@/lib/db";
import { generateToken, hashToken, verifyTokenHash } from "./tokens";
import { normalizeEmail } from "./email";
import { resolvedInviteTtlHours } from "@/lib/settings/platform";
import type { Role } from "@/generated/prisma/enums";

async function ttlMs() {
  return (await resolvedInviteTtlHours()) * 3600_000;
}

export async function createInvite(input: {
  email: string;
  name: string;
  role: Role;
  createdById?: string | null;
  phone?: string | null;
  company?: string | null;
  /** How long the link works; the policy's invite TTL when omitted. */
  ttlHours?: number;
}) {
  const token = generateToken();
  const inv = await db.invite.create({
    data: {
      email: normalizeEmail(input.email),
      name: input.name,
      role: input.role,
      phone: input.phone ?? null,
      company: input.company ?? null,
      tokenHash: await hashToken(token),
      expiresAt: new Date(Date.now() + (input.ttlHours ? input.ttlHours * 3600_000 : await ttlMs())),
      createdById: input.createdById ?? null,
    },
  });
  return { id: inv.id, token };
}

export async function verifyInvite(token: string) {
  // argon2 hash → a unique tokenHash lookup isn't possible; scan all valid invites.
  const candidates = await db.invite.findMany({ where: { usedAt: null, expiresAt: { gt: new Date() } } });
  for (const inv of candidates) {
    if (await verifyTokenHash(token, inv.tokenHash)) return inv;
  }
  return null;
}
