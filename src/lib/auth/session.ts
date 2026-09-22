import type { NextRequest } from "next/server";
import { clientIp } from "@/lib/request-ip";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { generateToken, sha256 } from "./tokens";
import { cookieSecure, cookieDomain } from "./cookies";
import { getSessionPolicy, sessionTtlMs, idleExpired, evictionIds } from "@/lib/policy/session-policy";

export const SESSION_COOKIE = "ca_session";

// envTtlHours is the fallback session lifetime (hours) when no policy
// max-session-lifetime is set: the SESSION_TTL_HOURS env, else 12. The policy
// value (SessionPolicy.maxSessionHours, editable at /admin/policy) always wins.
function envTtlHours(): number {
  const h = Number(process.env.SESSION_TTL_HOURS ?? "12");
  return Number.isFinite(h) && h > 0 ? h : 12;
}

export async function createSession(userId: string, meta?: { userAgent?: string; ip?: string }): Promise<string> {
  const token = generateToken();
  const policy = await getSessionPolicy();
  const ttl = sessionTtlMs(policy.maxSessionHours, envTtlHours());

  // Concurrent-session cap: evict the user's oldest live sessions to make room.
  if (policy.maxConcurrentPerUser && policy.maxConcurrentPerUser > 0) {
    const active = await db.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const evict = evictionIds(active, policy.maxConcurrentPerUser);
    if (evict.length) await db.session.deleteMany({ where: { id: { in: evict } } });
  }

  await db.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttl),
      userAgent: meta?.userAgent ?? null,
      ip: meta?.ip ?? null,
    },
  });
  return token;
}

export async function getSessionUser(token: string) {
  if (!token) return null;
  const s = await db.session.findFirst({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date()) return null;
  if (s.user.status !== "ACTIVE") return null;
  // Idle timeout: lastSeenAt is the previous request's time, so this measures
  // true inactivity. Covers both console + vendor sessions (shared function).
  const policy = await getSessionPolicy();
  if (idleExpired(s.lastSeenAt, new Date(), policy.idleTimeoutMinutes)) {
    await db.session.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  // sliding: update last-seen (extending expiry is optional — MVP only updates lastSeenAt)
  await db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return s.user;
}

export async function destroySession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}
export async function revokeSession(sessionId: string): Promise<void> {
  await db.session.delete({ where: { id: sessionId } }).catch(() => {});
}

// sessionCookieMaxAgeSeconds is the ca_session cookie's max-age, kept in lockstep
// with the session record's TTL: the policy max-session-lifetime governs, else
// the env fallback. Shared by every login path (passkey verify + OIDC) so the
// cookie never outlives the DB session (a policy of "1h" no longer left a 12h
// cookie behind).
export async function sessionCookieMaxAgeSeconds(): Promise<number> {
  const policy = await getSessionPolicy();
  return sessionTtlMs(policy.maxSessionHours, envTtlHours()) / 1000;
}

/** Create a DB-backed session for `userId` and set the `ca_session` cookie,
 *  identically to the passkey auth route. Used by non-passkey logins (OIDC). */
export async function startSession(userId: string, req: NextRequest): Promise<void> {
  const meta = {
    userAgent: req.headers.get("user-agent") ?? undefined,
    // The FIRST X-Forwarded-For hop is whatever the caller typed; clientIp
    // reads the one our own proxy wrote (see lib/request-ip.ts).
    ip: clientIp(req.headers),
  };
  const token = await createSession(userId, meta);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: await cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: await sessionCookieMaxAgeSeconds(),
    domain: cookieDomain(),
  });
}

/** The current request's session id from the ca_session cookie, or null.
 *  Read-only — used by the admin sessions page to mark "this device" and to
 *  exclude the caller's own session from bulk-revoke. Does not touch auth state. */
export async function currentSessionId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { id: true } });
  return s?.id ?? null;
}
