import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { recordAdminAction } from "@/lib/audit/admin";
import { callConnector, canRotate } from "@/lib/vault/rotation";
import { kickRotation } from "@/lib/vault/rotation-pass";
import { rotationStatus } from "@/lib/vault/rotation-status";
import { sealsOf } from "@/lib/vault/store";
import { isSealedValue, isVaultPublicKey } from "@/lib/vault/seal";

// Password check-out: a person with an active grant takes the saved password of
// a resource to use it themselves (a console, a tool that cannot go through
// Captivo), for a while and for a reason. One person at a time. The connector
// seals the password to a key only the person's browser holds, so it never
// passes through the console readable. When the check-out ends (returned, out
// of time, or the grant gone) the password is changed by rotation, or, where
// the target cannot be rotated, the admins are told that it still stands.

export { CHECKOUT_DEFAULT_MINUTES, CHECKOUT_MAX_MINUTES, CHECKOUT_MIN_MINUTES, validCheckoutMinutes } from "@/lib/vault/checkout-limits";

export type CheckoutBlock = "off" | "kind" | "vault" | "unsealed" | "moderated";

export const CHECKOUT_BLOCK_TEXT: Record<CheckoutBlock, string> = {
  off: "Password check-out is not turned on for this resource.",
  kind: "Only a remote desktop, SSH or database password can be checked out.",
  vault: "This credential lives in your own vault; read it there.",
  unsealed: "The saved password is not sealed to a connector yet, so it cannot be handed out safely.",
  moderated: "A resource that needs a moderator cannot be used outside Captivo: the password stays.",
};

/** Why a password cannot be checked out of this resource, or null. */
export function checkoutBlock(
  s: { passwordCheckout: boolean; accessMode: string; requireModerator?: boolean },
  c: { secretKind: string; secretSource?: string | null; sealedTo: string | null } | null,
): CheckoutBlock | null {
  if (!s.passwordCheckout) return "off";
  if (!c || c.secretKind !== "PASSWORD" || (s.accessMode !== "GATEWAY" && s.accessMode !== "DATABASE")) return "kind";
  if (c.secretSource) return "vault";
  if (!c.sealedTo) return "unsealed";
  if (s.requireModerator) return "moderated";
  return null;
}

/** When a check-out started now ends: the resource's limit, or the grant's end, whichever is first. */
export function checkoutEnd(now: Date, maxMinutes: number, grantEnd: Date | null): Date {
  const byLimit = new Date(now.getTime() + maxMinutes * 60_000);
  return grantEnd && grantEnd < byLimit ? grantEnd : byLimit;
}

export type ActiveCheckout = { id: string; userId: string; userName: string; reason: string; startedAt: Date; endsAt: Date };

/** The check-out that runs now on a resource, if any. */
export async function activeCheckout(siteId: string, now = new Date()): Promise<ActiveCheckout | null> {
  const r = await db.credentialCheckout.findFirst({
    where: { siteId, endedBy: null, endsAt: { gt: now } },
    select: { id: true, userId: true, reason: true, startedAt: true, endsAt: true, user: { select: { name: true, email: true } } },
  });
  return r ? { id: r.id, userId: r.userId, userName: r.user.name || r.user.email, reason: r.reason, startedAt: r.startedAt, endsAt: r.endsAt } : null;
}

export type StartResult =
  | { ok: true; id: string; sealed: string; target: { host: string; port: number; username: string }; endsAt: Date; willRotate: boolean }
  | { ok: false; status: number; error: string; detail?: string; by?: string; until?: Date };

/**
 * Hands the saved password to a person, sealed to the browser key they give. Runs
 * in the resource's tenant scope. The connector's answer is the only place the
 * password is opened; this side stores who, why and until when.
 */
export async function startCheckout(o: { userId: string; userEmail: string; siteId: string; reason: string; publicKey: string; grantEnd: Date | null; ip: string | null; now?: Date }): Promise<StartResult> {
  const now = o.now ?? new Date();
  if (o.reason.trim().length < 10) return { ok: false, status: 400, error: "reason_required" };
  if (!isVaultPublicKey(o.publicKey)) return { ok: false, status: 400, error: "invalid_key" };
  const decision = await evaluateAccess(o.userId, o.siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden" };

  const site = await db.site.findUnique({
    where: { id: o.siteId },
    select: { name: true, accessMode: true, passwordCheckout: true, checkoutMaxMinutes: true, requireModerator: true, vaultCredential: { select: { secretKind: true, secretSource: true, sealedTo: true, secret: true, extraSeals: true } } },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const block = checkoutBlock(site, site.vaultCredential);
  if (block) return { ok: false, status: 409, error: `checkout_${block}`, detail: CHECKOUT_BLOCK_TEXT[block] };

  const st = await rotationStatus(o.siteId);
  if (!st || !site.vaultCredential) return { ok: false, status: 404, error: "not_found" };
  if (st.waiting) return { ok: false, status: 409, error: "rotation_waiting", detail: st.waiting };

  // One at a time. One that ran out and was not tidied yet is ended here, without
  // changing the password: this check-out's own end does that.
  const running = await db.credentialCheckout.findFirst({ where: { siteId: o.siteId, endedBy: null }, select: { id: true, userId: true, endsAt: true, user: { select: { name: true, email: true } } } });
  if (running && running.endsAt > now) return { ok: false, status: 409, error: "checked_out", by: running.user.name || running.user.email, until: running.endsAt };
  if (running) await db.credentialCheckout.updateMany({ where: { id: running.id, endedBy: null }, data: { endedBy: "expired", returnedAt: now } });

  const endsAt = checkoutEnd(now, site.checkoutMaxMinutes, o.grantEnd);
  if (endsAt <= now) return { ok: false, status: 409, error: "grant_ended" };
  const row = await db.credentialCheckout.create({ data: { siteId: o.siteId, userId: o.userId, reason: o.reason.trim().slice(0, 500), endsAt, clientIp: o.ip } });

  const seals = sealsOf(site.vaultCredential);
  const holders = await db.connector.findMany({ where: { id: { in: st.keys.map((k) => k.connectorId) } }, select: { id: true, name: true, status: true, version: true, vaultPublicKey: true }, orderBy: { id: "asc" } });
  const pick = holders.find((h) => canRotate(h, st.method) && h.vaultPublicKey && seals[h.vaultPublicKey]);
  const undo = () => db.credentialCheckout.deleteMany({ where: { id: row.id } });
  if (!pick) {
    await undo();
    return { ok: false, status: 409, error: "rotation_waiting", detail: st.waiting ?? "No connector can open it now." };
  }
  const ans = await callConnector(pick.id, {
    op: "reveal", method: st.method ?? "linux", host: st.target.host, port: String(st.target.port), username: st.target.username,
    current: seals[pick.vaultPublicKey!], to: [o.publicKey],
  });
  const sealed = ans.seals?.[o.publicKey];
  if (ans.error || !isSealedValue(sealed)) {
    await undo();
    return { ok: false, status: 502, error: "reveal_failed", detail: ans.error ?? "The connector's answer was unreadable." };
  }
  // Nothing changes this password until the check-out is over.
  await db.vaultCredential.update({ where: { siteId: o.siteId }, data: { rotateDueAt: endsAt } });
  const willRotate = !!st.method && !st.unsupported;
  await recordAdminAction({
    actor: { id: o.userId, email: o.userEmail }, action: "credential.checkout", targetType: "resource", targetId: o.siteId,
    summary: `Checked out the password of ${st.target.username}@${st.target.host} on "${site.name}" until ${endsAt.toISOString()}: ${o.reason.trim()}`.slice(0, 500),
    metadata: { checkoutId: row.id, connectorId: pick.id, endsAt: endsAt.toISOString(), willRotate },
    clientIp: o.ip,
  });
  await db.notification.create({ data: { type: "credential_checkout", siteId: o.siteId, siteName: site.name, detail: `${o.userEmail} took the password of ${st.target.username}: ${o.reason.trim().slice(0, 200)}` } }).catch(() => undefined);
  return { ok: true, id: row.id, sealed, target: st.target, endsAt, willRotate };
}

/**
 * Ends a check-out and sees to the password: rotation now, or a notice that it
 * could not be rotated. Returns false when it had already ended.
 */
export async function endCheckout(id: string, by: "returned" | "expired" | "revoked" | "admin", actor: { id: string; email: string | null } | null, now = new Date()): Promise<boolean> {
  const row = await db.credentialCheckout.findUnique({ where: { id }, select: { siteId: true, userId: true, user: { select: { email: true } }, site: { select: { name: true } } } });
  if (!row) return false;
  const res = await db.credentialCheckout.updateMany({ where: { id, endedBy: null }, data: { endedBy: by, returnedAt: now } });
  if (res.count === 0) return false;
  const st = await rotationStatus(row.siteId);
  const rotating = !!st && !st.unsupported && !st.waiting && st.method !== null;
  if (rotating) {
    await db.vaultCredential.update({ where: { siteId: row.siteId }, data: { rotateDueAt: now } });
    kickRotation(2_000, { siteId: row.siteId, force: true, actor });
  }
  const who = actor ?? { id: row.userId, email: row.user.email };
  await recordAdminAction({
    actor: who, action: "credential.checkin", targetType: "resource", targetId: row.siteId,
    summary: `The check-out of "${row.site.name}" by ${row.user.email} ended (${by}); ${rotating ? "the password is being changed" : "the password was not changed"}`,
    metadata: { checkoutId: id, by, rotating },
  });
  if (!rotating) {
    await db.notification.create({ data: { type: "checkout_not_rotated", siteId: row.siteId, siteName: row.site.name, detail: `${row.user.email} no longer holds the password, but it could not be changed automatically (this resource's password is not rotated): it still stands. Change it on the target and enter it again.` } }).catch(() => undefined);
  }
  return true;
}

/** From the health cron: ends what ran out or lost its grant. */
export async function processCheckouts(now = new Date()): Promise<number> {
  const rows = await db.credentialCheckout.findMany({ where: { endedBy: null }, select: { id: true, siteId: true, userId: true, endsAt: true } });
  let n = 0;
  for (const r of rows) {
    if (r.endsAt <= now) {
      if (await endCheckout(r.id, "expired", null, now)) n++;
    } else if (!(await evaluateAccess(r.userId, r.siteId, now)).allow) {
      if (await endCheckout(r.id, "revoked", null, now)) n++;
    }
  }
  return n;
}
