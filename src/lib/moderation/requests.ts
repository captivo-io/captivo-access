import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { sendMail } from "@/lib/email/mailer";
import { moderationRequestEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { pushToCapability } from "@/lib/mobile/push";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { resolvedModeratorRoles } from "@/lib/settings/platform";
import type { Role } from "@/generated/prisma/enums";
import { ADMISSION_MS, MODERATION_WAIT_MS, canModerate, moderatorRoleList, statusOf, type ModerationKind, type ModerationStatus } from "./rules";

// The store of moderation requests (rules.ts). Runs inside the tenant's scope.

export interface RequestView {
  id: string;
  status: ModerationStatus;
  requestedAt: string;
  /** The waiting request runs out here. */
  expiresAt: string;
}

function viewOf(r: { id: string; status: string; requestedAt: Date; decidedAt: Date | null }, now: Date): RequestView {
  return { id: r.id, status: statusOf(r, now), requestedAt: r.requestedAt.toISOString(), expiresAt: new Date(r.requestedAt.getTime() + MODERATION_WAIT_MS).toISOString() };
}

/**
 * The user's request to start a session here: the one still waiting (or
 * admitted and not yet used), else a new one, which tells the moderators.
 */
export async function openRequest(siteId: string, user: { id: string; name: string; email: string }, kind: ModerationKind, siteName: string, now = new Date()): Promise<RequestView> {
  const open = await db.moderationRequest.findFirst({
    where: { siteId, userId: user.id, kind, status: { in: ["waiting", "admitted"] }, requestedAt: { gt: new Date(now.getTime() - MODERATION_WAIT_MS) } },
    orderBy: { requestedAt: "desc" },
  });
  if (open && ["waiting", "admitted"].includes(statusOf(open, now))) return viewOf(open, now);
  const r = await db.moderationRequest.create({ data: { tenantId: currentTenantId(), siteId, userId: user.id, kind } });
  await tellModerators(user, siteName, r.id);
  return viewOf(r, now);
}

/** Best-effort: mail and phones of everyone who may moderate. */
async function tellModerators(user: { name: string; email: string }, siteName: string, requestId: string): Promise<void> {
  const roles = await resolvedModeratorRoles();
  if (await notifyEmailEnabled("access_requests")) {
    try {
      const to = (await db.user.findMany({ where: { role: { in: moderatorRoleList(roles) }, status: "ACTIVE" }, select: { email: true } })).map((u) => u.email).filter((e) => e !== user.email);
      if (to.length > 0) {
        const m = moderationRequestEmail({ userName: user.name, userEmail: user.email, siteName, consoleUrl: await consoleBaseUrl() });
        await sendMail({ to, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best-effort: telling moderators never fails the request.
    }
  }
  try {
    await pushToCapability(roles === "admins" ? "configure" : "approve_grants", {
      title: "Moderator needed",
      body: `${user.name} is waiting to start a session on ${siteName}`,
      data: { type: "moderation_request", requestId, origin: await consoleBaseUrl() },
    });
  } catch {
    // Best-effort.
  }
}

/** The user's own request, as their waiting page shows it. */
export async function requestFor(id: string, userId: string, now = new Date()): Promise<RequestView | null> {
  const r = await db.moderationRequest.findFirst({ where: { id, userId } });
  return r ? viewOf(r, now) : null;
}

export async function cancelRequest(id: string, userId: string): Promise<void> {
  await db.moderationRequest.updateMany({ where: { id, userId, status: { in: ["waiting", "admitted"] } }, data: { status: "cancelled" } });
}

export type DecideError = "not_found" | "not_moderator" | "own_session" | "not_waiting";

/** A moderator admits (or declines) a waiting request. */
export async function decideRequest(id: string, moderator: { id: string; email: string; role: Role }, admit: boolean, now = new Date()): Promise<{ ok: true; siteId: string; userId: string } | { ok: false; error: DecideError }> {
  if (!canModerate(moderator.role, await resolvedModeratorRoles())) return { ok: false, error: "not_moderator" };
  const r = await db.moderationRequest.findUnique({ where: { id } });
  if (!r) return { ok: false, error: "not_found" };
  if (r.userId === moderator.id) return { ok: false, error: "own_session" };
  if (statusOf(r, now) !== "waiting") return { ok: false, error: "not_waiting" };
  const done = await db.moderationRequest.updateMany({
    where: { id, status: "waiting" },
    data: { status: admit ? "admitted" : "declined", moderatorId: moderator.id, moderatorEmail: moderator.email, decidedAt: now },
  });
  if (done.count !== 1) return { ok: false, error: "not_waiting" };
  return { ok: true, siteId: r.siteId, userId: r.userId };
}

/**
 * Starting the session uses the admission: the latest one for this user, site
 * and kind still in time. Null when there is none. Once only.
 */
export async function takeAdmission(siteId: string, userId: string, kind: ModerationKind, now = new Date()): Promise<{ id: string; moderatorId: string } | null> {
  const r = await findAdmission(siteId, userId, kind, now);
  if (!r) return null;
  const done = await db.moderationRequest.updateMany({ where: { id: r.id, status: "admitted" }, data: { status: "started", startedAt: now } });
  return done.count === 1 ? { id: r.id, moderatorId: r.moderatorId } : null;
}

/** Whether the user holds an admission still in time (the SSH command asks before handing it out). */
export async function hasAdmission(siteId: string, userId: string, kind: ModerationKind, now = new Date()): Promise<boolean> {
  return (await findAdmission(siteId, userId, kind, now)) !== null;
}

async function findAdmission(siteId: string, userId: string, kind: ModerationKind, now: Date): Promise<{ id: string; moderatorId: string } | null> {
  const r = await db.moderationRequest.findFirst({
    where: { siteId, userId, kind, status: "admitted", decidedAt: { gt: new Date(now.getTime() - ADMISSION_MS) } },
    orderBy: { decidedAt: "desc" },
    select: { id: true, moderatorId: true },
  });
  return r?.moderatorId ? { id: r.id, moderatorId: r.moderatorId } : null;
}

export interface WaitingRequest {
  id: string;
  siteId: string;
  siteName: string;
  userId: string;
  userName: string;
  userEmail: string;
  kind: ModerationKind;
  requestedAt: string;
  expiresAt: string;
}

/** Requests waiting for a moderator now, oldest first (Live sessions, the bell). */
export async function waitingRequests(now = new Date()): Promise<WaitingRequest[]> {
  const rows = await db.moderationRequest.findMany({
    where: { status: "waiting", requestedAt: { gt: new Date(now.getTime() - MODERATION_WAIT_MS) } },
    orderBy: { requestedAt: "asc" },
    take: 50,
  });
  if (rows.length === 0) return [];
  const [users, sites] = await Promise.all([
    db.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, email: true } }),
    db.site.findMany({ where: { id: { in: rows.map((r) => r.siteId) } }, select: { id: true, name: true } }),
  ]);
  const user = new Map(users.map((u) => [u.id, u]));
  const site = new Map(sites.map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id, siteId: r.siteId, siteName: site.get(r.siteId) ?? "Removed resource",
    userId: r.userId, userName: user.get(r.userId)?.name ?? "Unknown user", userEmail: user.get(r.userId)?.email ?? "",
    kind: r.kind === "ssh" ? "ssh" : "browser",
    requestedAt: r.requestedAt.toISOString(), expiresAt: new Date(r.requestedAt.getTime() + MODERATION_WAIT_MS).toISOString(),
  }));
}
