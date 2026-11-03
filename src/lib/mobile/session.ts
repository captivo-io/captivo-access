import { db } from "@/lib/db";
import { generateToken, sha256 } from "@/lib/auth/tokens";
import { pkceMatches } from "./handoff";

/**
 * App sign-ins are Session rows with `mobile` set, so everything that ends a
 * person's sessions -- Captivo ID single sign-out, removal, a role change, an
 * admin revoking it on the sessions page, a disabled account -- ends the
 * phone's too, with no second list to keep in step.
 *
 * They are NOT held to the console's idle timeout or lifetime policy: those
 * are written for browsers on shared machines, and a phone that is signed out
 * every twelve hours cannot be woken by a push to approve anything. Thirty
 * days from sign-in, then the app signs in again (usually one tap, the centre
 * still knows the person).
 */
export const MOBILE_SESSION_DAYS = 30;
const CODE_TTL_MS = 2 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A one-time code for the app, bound to its PKCE challenge. */
export async function issueMobileCode(
  userId: string,
  challenge: string,
  meta: { amr: string[]; userAgent?: string | null; ip?: string | null },
): Promise<string> {
  const code = generateToken();
  await db.session.create({
    data: {
      userId,
      tokenHash: sha256(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      mobile: true,
      mobileChallenge: challenge,
      amr: meta.amr,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  });
  return code;
}

/**
 * Trades a code + verifier for the app's bearer token. Single use: the row's
 * hash is swapped conditionally, so a second redemption of the same code (or
 * two racing) finds nothing. A wrong verifier burns the code.
 */
export async function redeemMobileCode(
  code: unknown,
  verifier: unknown,
  device?: string | null,
): Promise<{ token: string; userId: string } | null> {
  if (typeof code !== "string" || !code) return null;
  const row = await db.session.findFirst({
    where: { tokenHash: sha256(code), mobile: true, mobileChallenge: { not: null } },
    select: { id: true, userId: true, mobileChallenge: true, expiresAt: true },
  });
  if (!row || !row.mobileChallenge) return null;
  if (row.expiresAt < new Date() || !pkceMatches(verifier, row.mobileChallenge)) {
    await db.session.deleteMany({ where: { id: row.id } });
    return null;
  }
  const token = generateToken();
  const res = await db.session.updateMany({
    where: { id: row.id, tokenHash: sha256(code) },
    data: {
      tokenHash: sha256(token),
      mobileChallenge: null,
      expiresAt: new Date(Date.now() + MOBILE_SESSION_DAYS * DAY_MS),
      lastSeenAt: new Date(),
      ...(device ? { userAgent: device.slice(0, 200) } : {}),
    },
  });
  return res.count === 1 ? { token, userId: row.userId } : null;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m ? m[1] : null;
}

/** The person behind an app bearer token, with the sign-in's own id. */
export async function mobileSessionFromRequest(req: Request) {
  const token = bearerToken(req);
  if (!token) return null;
  const s = await db.session.findFirst({
    where: { tokenHash: sha256(token), mobile: true, mobileChallenge: null },
    include: { user: true },
  });
  if (!s || s.expiresAt < new Date() || s.user.status !== "ACTIVE") return null;
  await db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return { sessionId: s.id, user: s.user };
}

export async function endMobileSession(sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId, mobile: true } });
}
