// A workspace admin closing their own workspace (Cloud only). The rules are in
// close-gate.ts; this file gathers the facts they need and does the closing.
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { SUPPORT_COOKIE, SUPPORT_USER_EMAIL } from "@/lib/support/session";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { currentTenantId } from "@/lib/tenant/context";
import { closeRefusal, type CloseFacts, type CloseRefusal } from "./close-gate";

export { SUPPORT_ADDRESS } from "./close-gate";

/**
 * The facts about this request the close rules need. A support session counts
 * as support whichever cookie carried it; the session's age is read from its
 * own row, so a fresh sign-in (a new row) is what makes it recent.
 */
export async function closeFacts(user: { email: string; role: string }, slug: string | null): Promise<CloseFacts> {
  const c = await cookies();
  const support = !!c.get(SUPPORT_COOKIE)?.value || user.email === SUPPORT_USER_EMAIL;
  let sessionCreatedAt: Date | null = null;
  const token = c.get(SESSION_COOKIE)?.value;
  if (!support && token) {
    const s = await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { createdAt: true } });
    sessionCreatedAt = s?.createdAt ?? null;
  }
  return { multiTenant: multiTenantEnabled(), tenantId: currentTenantId(), slug, role: user.role, support, sessionCreatedAt, now: new Date() };
}

export async function closeRefusalFor(user: { email: string; role: string }, slug: string | null, confirmSlug?: unknown): Promise<CloseRefusal | null> {
  return closeRefusal(await closeFacts(user, slug), confirmSlug);
}

/** What closing takes away, for the page to say so in numbers. */
export async function workspaceCounts(): Promise<{ users: number; resources: number; connectors: number; recordings: number }> {
  const [users, resources, connectors, recordings] = await Promise.all([
    db.user.count({ where: { email: { not: SUPPORT_USER_EMAIL } } }),
    db.site.count(),
    db.connector.count(),
    db.sessionRecording.count(),
  ]);
  return { users, resources, connectors, recordings };
}

/**
 * Soft-deletes the current tenant (platform_delete_tenant: suspended, deletedAt
 * set, every session gone) INSIDE the request's own scope. Not deleteTenant():
 * that runs on a separate connection, and this request's scope already holds a
 * row lock on the caller's Session row (getSessionUser touches lastSeenAt), so
 * the function's DELETE of the tenant's sessions would wait on it until the
 * scope timed out. In-scope it also commits together with the audit entry.
 */
export async function softDeleteCurrentTenant(): Promise<void> {
  await db.$executeRawUnsafe(`SELECT platform_delete_tenant($1)`, currentTenantId());
}
