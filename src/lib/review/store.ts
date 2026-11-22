import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { revokeGrant } from "@/lib/access/grants";
import { recordAdminAction, type AdminActor } from "@/lib/audit/admin";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { decisionAllowed, dueAt, nextOpening, outcomeFor, remindersDue, REVIEWER_ROLES, summarize, type Decision, type Outcome, type Recurrence } from "./plan";

// Access reviews, the database side (rules in ./plan.ts). A review lists the
// live grants when it opens, reviewers record a decision per grant until it
// closes, and closing applies them: revoked grants end, limited ones get an end
// date, and what nobody answered follows the review's rule. Directory grants
// are never revoked here; they are listed for removal from their group.

export type Actor = { id: string; email: string; name?: string | null };

const SYSTEM: AdminActor = { id: "system", email: null };


export async function createReview(input: {
  name: string; siteIds: string[]; dueDays: number; onNoAnswer: "revoke" | "keep"; recurrence: Recurrence | null; opensAt: Date | null;
}, actor: Actor, now = new Date()) {
  const opensAt = input.opensAt && input.opensAt > now ? input.opensAt : now;
  const review = await db.accessReview.create({
    data: {
      name: input.name, siteIds: input.siteIds, dueDays: input.dueDays, onNoAnswer: input.onNoAnswer, recurrence: input.recurrence,
      opensAt, status: "scheduled", createdById: actor.id,
    },
  });
  await recordAdminAction({
    actor, action: "review.create", targetType: "review", targetId: review.id,
    summary: `Created access review "${input.name}"${input.recurrence ? ` (${input.recurrence})` : ""}`,
  });
  if (opensAt <= now) await openReview(review.id, now);
  return review.id;
}

/**
 * Opens a scheduled review: one item per live grant in scope, with when it was
 * last used (the newest allowed access in the audit log).
 */
export async function openReview(id: string, now = new Date()): Promise<number> {
  const r = await db.accessReview.findUnique({ where: { id } });
  if (!r || r.status !== "scheduled") return 0;
  const grants = await db.accessGrant.findMany({
    where: {
      status: "ACTIVE",
      OR: [{ requiresApproval: false }, { approvedAt: { not: null } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      ...(r.siteIds.length ? { siteId: { in: r.siteIds } } : {}),
    },
    select: {
      id: true, userId: true, siteId: true, createdAt: true, endsAt: true, startsAt: true, schedule: true, directoryManaged: true,
      user: { select: { name: true, email: true, role: true } },
      site: { select: { name: true } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  const used = grants.length
    ? await db.auditEvent.groupBy({
        by: ["userId", "siteId"],
        where: { decision: "ALLOW", userId: { in: [...new Set(grants.map((g) => g.userId))] }, siteId: { in: [...new Set(grants.map((g) => g.siteId))] } },
        _max: { timestamp: true },
      })
    : [];
  const last = new Map(used.map((u) => [`${u.userId}\x00${u.siteId}`, u._max.timestamp]));
  await db.accessReviewItem.createMany({
    data: grants.map((g) => ({
      reviewId: id, grantId: g.id, userId: g.userId, siteId: g.siteId,
      userLabel: g.user.name ?? g.user.email, userEmail: g.user.email, userRole: g.user.role,
      siteName: g.site.name, grantCreatedAt: g.createdAt, grantEndsAt: g.endsAt,
      grantedBy: g.createdBy ? (g.createdBy.name ?? g.createdBy.email) : g.directoryManaged ? "Directory group" : null,
      scheduled: g.schedule != null || (g.startsAt != null && g.startsAt > now),
      directoryManaged: g.directoryManaged,
      lastUsedAt: last.get(`${g.userId}\x00${g.siteId}`) ?? null,
    })),
  });
  await db.accessReview.update({ where: { id }, data: { status: "open", openedAt: now, dueAt: dueAt(now, r.dueDays) } });
  await db.notification.create({ data: { type: "review_open", siteName: r.name, detail: `${grants.length} grant${grants.length === 1 ? "" : "s"} to review` } }).catch(() => undefined);
  return grants.length;
}

export class ReviewError extends Error {}

/** Records one decision on several items. Applied when the review closes. */
export async function decide(reviewId: string, itemIds: string[], decision: Decision | null, limitTo: Date | null, actor: Actor, now = new Date()) {
  const r = await db.accessReview.findUnique({ where: { id: reviewId }, select: { status: true, name: true } });
  if (!r) throw new ReviewError("not_found");
  if (r.status !== "open") throw new ReviewError("not_open");
  if (decision === "limit" && (!limitTo || limitTo <= now)) throw new ReviewError("limit_in_past");
  const items = await db.accessReviewItem.findMany({ where: { reviewId, id: { in: itemIds } }, select: { id: true, userId: true, directoryManaged: true, userLabel: true, siteName: true } });
  const skipped: { id: string; why: string }[] = [];
  const ok: typeof items = [];
  for (const it of items) {
    const why = decision ? decisionAllowed(it, actor.id, decision) : it.userId === actor.id ? "own_access" : null;
    if (why) skipped.push({ id: it.id, why });
    else ok.push(it);
  }
  if (ok.length) {
    await db.accessReviewItem.updateMany({
      where: { id: { in: ok.map((i) => i.id) } },
      data: decision
        ? { decision, limitTo: decision === "limit" ? limitTo : null, decidedById: actor.id, decidedByLabel: actor.name ?? actor.email, decidedAt: now }
        : { decision: null, limitTo: null, decidedById: null, decidedByLabel: null, decidedAt: null },
    });
    await recordAdminAction({
      actor, action: "review.decide", targetType: "review", targetId: reviewId,
      summary: `${decision ? `Marked ${ok.length} grant${ok.length === 1 ? "" : "s"} "${decision}"` : `Cleared ${ok.length} decision${ok.length === 1 ? "" : "s"}`} in access review "${r.name}"`,
      metadata: { items: ok.map((i) => `${i.userLabel} → ${i.siteName}`).slice(0, 50), ...(limitTo ? { limitTo: limitTo.toISOString() } : {}) },
    });
  }
  return { done: ok.length, skipped };
}

/**
 * Closes a review and applies it. Grants that ended or changed meanwhile are
 * left as they are ("gone"); a recurring review schedules the next one.
 */
export async function closeReview(id: string, by: Actor | null, now = new Date()) {
  const r = await db.accessReview.findUnique({ where: { id }, include: { items: true } });
  if (!r || r.status !== "open") return null;
  const outcomes: Outcome[] = [];
  for (const it of r.items) {
    let o = outcomeFor(it, r.onNoAnswer);
    const grant = await db.accessGrant.findUnique({ where: { id: it.grantId }, select: { status: true, endsAt: true } });
    if (!grant || grant.status !== "ACTIVE" || (grant.endsAt && grant.endsAt <= now)) o = "gone";
    else if (o === "revoked" || o === "auto_revoked") {
      await revokeGrant(it.grantId, { userId: o === "revoked" ? it.decidedById : null, reason: `review:${id}` });
      await recordAdminAction({
        actor: o === "revoked" && it.decidedById ? { id: it.decidedById, email: (await db.user.findUnique({ where: { id: it.decidedById }, select: { email: true } }))?.email ?? null } : by ?? SYSTEM,
        action: "grant.revoke", targetType: "grant", targetId: it.grantId,
        summary: `Revoked ${it.userLabel}'s access to ${it.siteName} (access review "${r.name}"${o === "auto_revoked" ? ", no decision when it closed" : ""})`,
      });
    } else if (o === "limited" && it.limitTo && (!grant.endsAt || it.limitTo < grant.endsAt)) {
      await db.accessGrant.update({ where: { id: it.grantId }, data: { endsAt: it.limitTo } });
    }
    outcomes.push(o);
    await db.accessReviewItem.update({ where: { id: it.id }, data: { outcome: o } });
  }
  const summary = summarize(outcomes);
  await db.accessReview.update({ where: { id }, data: { status: "closed", closedAt: now, closedById: by?.id ?? null, summary: summary as Prisma.InputJsonValue } });
  await recordAdminAction({
    actor: by ?? SYSTEM, action: "review.close", targetType: "review", targetId: id,
    summary: `Closed access review "${r.name}"${by ? "" : " at its due date"}: ${summary.total} grants, ${(summary.revoked ?? 0) + (summary.auto_revoked ?? 0)} revoked, ${summary.kept ?? 0} kept`,
    metadata: summary,
  });
  await db.notification.create({ data: { type: "review_closed", siteName: r.name, detail: `${(summary.revoked ?? 0) + (summary.auto_revoked ?? 0)} revoked, ${summary.kept ?? 0} kept${summary.ad_remove ? `, ${summary.ad_remove} to remove from directory groups` : ""}` } }).catch(() => undefined);
  if (r.recurrence) {
    await db.accessReview.create({
      data: {
        name: r.name, siteIds: r.siteIds, dueDays: r.dueDays, onNoAnswer: r.onNoAnswer, recurrence: r.recurrence,
        opensAt: nextOpening(r.openedAt ?? r.opensAt, r.recurrence as Recurrence), status: "scheduled", createdById: r.createdById,
      },
    });
  }
  return summary;
}

export async function cancelReview(id: string, actor: Actor) {
  const r = await db.accessReview.findUnique({ where: { id }, select: { status: true, name: true } });
  if (!r || (r.status !== "open" && r.status !== "scheduled")) return false;
  await db.accessReview.update({ where: { id }, data: { status: "cancelled", closedAt: new Date(), closedById: actor.id } });
  await recordAdminAction({ actor, action: "review.cancel", targetType: "review", targetId: id, summary: `Cancelled access review "${r.name}"; no access was changed` });
  return true;
}

export type ReviewMail = { kind: "open" | "week" | "day"; name: string; due: Date; pending: number; url: string; to: string[] };

/**
 * One pass of the scheduler for the current tenant: opens what is due to open,
 * closes what is past due, and returns the reminders to send (mail goes out
 * after the tenant scope closes).
 */
export async function runReviewPass(now = new Date()): Promise<{ opened: number; closed: number; mail: ReviewMail[] }> {
  const mail: ReviewMail[] = [];
  let opened = 0, closed = 0;
  const base = await consoleBaseUrl().catch(() => "");
  const reviewers = async () => (await db.user.findMany({ where: { role: { in: [...REVIEWER_ROLES] }, status: "ACTIVE" }, select: { email: true } })).map((u) => u.email);
  for (const r of await db.accessReview.findMany({ where: { status: "scheduled", opensAt: { lte: now } }, select: { id: true } })) {
    const n = await openReview(r.id, now);
    opened++;
    const o = await db.accessReview.findUnique({ where: { id: r.id }, select: { name: true, dueAt: true } });
    if (o?.dueAt && n > 0) mail.push({ kind: "open", name: o.name, due: o.dueAt, pending: n, url: `${base}/admin/reviews/${r.id}`, to: await reviewers() });
  }
  for (const r of await db.accessReview.findMany({ where: { status: "open" }, select: { id: true, name: true, dueAt: true, reminders: true } })) {
    if (!r.dueAt) continue;
    if (r.dueAt <= now) {
      await closeReview(r.id, null, now);
      closed++;
      continue;
    }
    const bits = remindersDue(r.dueAt, r.reminders, now);
    if (!bits) continue;
    await db.accessReview.update({ where: { id: r.id }, data: { reminders: r.reminders | bits } });
    const pending = await db.accessReviewItem.count({ where: { reviewId: r.id, decision: null } });
    if (pending === 0) continue;
    await db.notification.create({ data: { type: "review_due", siteName: r.name, detail: `${pending} grant${pending === 1 ? "" : "s"} still to review` } }).catch(() => undefined);
    mail.push({ kind: bits & 2 ? "day" : "week", name: r.name, due: r.dueAt, pending, url: `${base}/admin/reviews/${r.id}`, to: await reviewers() });
  }
  return { opened, closed, mail };
}
