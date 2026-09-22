// Support access (Cloud, break-glass): a platform admin opens a tenant console
// for a limited time WITHOUT touching their own platform session. The tenant
// host sets a host-only `ca_support` cookie (never the shared-domain ca_session),
// backed by a real Session row for a per-tenant support user. Everything is
// visible to the tenant: the support user in Users, the start/end in its admin
// chain, and a banner while the session is live.
import { cookies } from "next/headers";
import { clientIp } from "@/lib/request-ip";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { sha256, generateToken } from "@/lib/auth/tokens";
import { cookieSecure } from "@/lib/auth/cookies";
import { recordAdminAction } from "@/lib/audit/admin";

export const SUPPORT_COOKIE = "ca_support";
export const SUPPORT_SESSION_MS = 60 * 60_000; // 1 hour
export const HANDOFF_TTL_MS = 2 * 60_000; // the one-time link must be used within 2 minutes
export const SUPPORT_USER_EMAIL = "platform-support@captivo.local"; // non-routable, one per tenant (RLS)
export const SUPPORT_USER_NAME = "Captivo Support";

export interface SupportSessionInfo { sessionId: string; expiresAt: Date; actorEmail: string; reason: string }

// The tenant-side support user (created on first use). ADMIN so support can see
// what the tenant's admin sees; directoryManaged so it reads as a managed
// system account in the Users list.
async function ensureSupportUser(): Promise<string> {
  const existing = await db.user.findFirst({ where: { email: SUPPORT_USER_EMAIL }, select: { id: true, status: true } });
  if (existing) {
    if (existing.status !== "ACTIVE") throw new Error("support_user_disabled");
    return existing.id;
  }
  const u = await db.user.create({ data: { email: SUPPORT_USER_EMAIL, name: SUPPORT_USER_NAME, role: "ADMIN", status: "ACTIVE", directoryManaged: true } });
  return u.id;
}

// Consume a handoff token on the tenant host; returns the session cookie value.
// Must run inside the tenant's request scope.
export async function startSupportSession(token: string, req: NextRequest): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const h = await db.supportHandoff.findFirst({ where: { tokenHash: sha256(token) } });
  if (!h) return { ok: false, error: "invalid" };
  if (h.usedAt) return { ok: false, error: "used" };
  if (h.expiresAt < new Date()) return { ok: false, error: "expired" };
  let userId: string;
  try { userId = await ensureSupportUser(); } catch { return { ok: false, error: "support_user_disabled" }; }
  const sessionToken = generateToken();
  const session = await db.session.create({
    data: {
      userId, tokenHash: sha256(sessionToken), expiresAt: new Date(Date.now() + SUPPORT_SESSION_MS),
      // clientIp, not the first X-Forwarded-For hop: this row is the record of
      // a support session on a customer tenant, so its origin must not be a
      // value the caller chose.
      userAgent: req.headers.get("user-agent") ?? null, ip: clientIp(req.headers) ?? null,
    },
  });
  const consumed = await db.supportHandoff.updateMany({ where: { id: h.id, usedAt: null }, data: { usedAt: new Date(), sessionId: session.id } });
  if (consumed.count === 0) { await db.session.delete({ where: { id: session.id } }).catch(() => {}); return { ok: false, error: "used" }; }
  await recordAdminAction({ actor: { id: userId, email: h.actorEmail }, action: "platform.support.session_start", targetType: "tenant", summary: `[Captivo platform] Support session started by ${h.actorEmail}: ${h.reason}`, metadata: { platformActor: h.actorEmail, reason: h.reason, expiresAt: session.expiresAt.toISOString() } });
  return { ok: true, token: sessionToken };
}

export async function supportCookieOptions() {
  // Host-only on purpose (no `domain`): it must NOT be shared with the platform
  // host or other tenant consoles.
  return { httpOnly: true, secure: await cookieSecure(), sameSite: "lax" as const, path: "/", maxAge: Math.floor(SUPPORT_SESSION_MS / 1000) };
}

// Live support session for the current request (tenant scope), or null.
export async function supportSessionInfo(): Promise<SupportSessionInfo | null> {
  const token = (await cookies()).get(SUPPORT_COOKIE)?.value;
  if (!token) return null;
  const s = await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { id: true, expiresAt: true } }).catch(() => null);
  if (!s || s.expiresAt < new Date()) return null;
  const h = await db.supportHandoff.findFirst({ where: { sessionId: s.id }, select: { actorEmail: true, reason: true } }).catch(() => null);
  return { sessionId: s.id, expiresAt: s.expiresAt, actorEmail: h?.actorEmail ?? "platform", reason: h?.reason ?? "" };
}

// End the current support session (tenant scope): drop the Session, audit, clear the cookie.
export async function endSupportSession(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(SUPPORT_COOKIE)?.value;
  store.delete({ name: SUPPORT_COOKIE, path: "/" });
  if (!token) return false;
  const s = await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { id: true, userId: true } }).catch(() => null);
  if (!s) return false;
  const h = await db.supportHandoff.findFirst({ where: { sessionId: s.id }, select: { actorEmail: true } }).catch(() => null);
  await db.session.delete({ where: { id: s.id } }).catch(() => {});
  await recordAdminAction({ actor: { id: s.userId, email: h?.actorEmail ?? null }, action: "platform.support.session_end", targetType: "tenant", summary: `[Captivo platform] Support session ended (${h?.actorEmail ?? "platform"})`, metadata: { platformActor: h?.actorEmail } });
  return true;
}
