import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { findOwnSession, kickViewer, type ActiveSession } from "@/lib/dataplane/client";
import { resolvedSessionInvitesEnabled } from "@/lib/settings/platform";
import { recordAdminAction, type AdminActor } from "@/lib/audit/admin";
import { getSendingSmtpConfig, sendMail } from "@/lib/email/mailer";
import { sessionInviteEmail } from "@/lib/email/templates";
import { guestProviderAvailable } from "./guest-provider";
import {
  MAX_GUESTS_PER_SESSION, guestViewerId, hashSecret, inviteExpiry, inviteStatus, invitableSession, linkToken, newSecret,
  parseGuestPass, parseLinkToken, secretMatches, type InviteDuration, type InviteStatus,
} from "./invite-token";

// Session invites (see the SessionInvite model): an admin asks someone from
// outside into one live session; they sign in with Captivo ID and get a pass
// for that session alone. Everything here runs in the workspace's scope.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CreateInviteError =
  | "disabled" | "no_provider" | "not_found" | "not_invitable" | "bad_email" | "too_many";

export interface InviteView {
  id: string;
  email: string;
  canControl: boolean;
  untilSessionEnds: boolean;
  expiresAt: string;
  createdAt: string;
  createdByEmail: string | null;
  joinedAt: string | null;
  guestName: string | null;
  status: InviteStatus;
}

function view(r: {
  id: string; email: string; canControl: boolean; untilSessionEnds: boolean; expiresAt: Date; createdAt: Date;
  createdByEmail: string | null; joinedAt: Date | null; guestName: string | null; revokedAt: Date | null;
}, now = new Date()): InviteView {
  return {
    id: r.id, email: r.email, canControl: r.canControl, untilSessionEnds: r.untilSessionEnds,
    expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString(), createdByEmail: r.createdByEmail,
    joinedAt: r.joinedAt?.toISOString() ?? null, guestName: r.guestName, status: inviteStatus(r, now),
  };
}

/** Whether this workspace can invite at all, and why not. */
export async function invitesUnavailable(): Promise<"disabled" | "no_provider" | null> {
  if (!(await resolvedSessionInvitesEnabled())) return "disabled";
  if (!(await guestProviderAvailable())) return "no_provider";
  return null;
}

export async function listSessionInvites(sessionId: string): Promise<InviteView[]> {
  const rows = await db.sessionInvite.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
  const now = new Date();
  return rows.map((r) => view(r, now));
}

export async function createSessionInvite(input: {
  sessionId: string;
  email: string;
  canControl: boolean;
  duration: InviteDuration;
  actor: AdminActor;
  baseUrl: string;
  clientIp?: string | null;
}): Promise<{ ok: true; invite: InviteView; link: string; emailed: boolean } | { ok: false; error: CreateInviteError }> {
  const why = await invitesUnavailable();
  if (why) return { ok: false, error: why };
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, error: "bad_email" };
  const session = await findOwnSession(input.sessionId);
  if (!session) return { ok: false, error: "not_found" };
  if (!invitableSession(session)) return { ok: false, error: "not_invitable" };
  const now = new Date();
  const open = await db.sessionInvite.count({ where: { sessionId: input.sessionId, revokedAt: null, expiresAt: { gt: now } } });
  if (open >= MAX_GUESTS_PER_SESSION) return { ok: false, error: "too_many" };

  const secret = newSecret();
  const { expiresAt, untilSessionEnds } = inviteExpiry(input.duration, now);
  const row = await db.sessionInvite.create({
    data: {
      tenantId: currentTenantId(),
      sessionId: session.sessionId,
      siteId: session.siteId,
      sessionUserId: session.userId,
      email,
      canControl: input.canControl,
      untilSessionEnds,
      linkHash: hashSecret(secret),
      expiresAt,
      createdById: input.actor.id,
      createdByEmail: input.actor.email,
    },
  });
  const link = `${input.baseUrl}/join/${linkToken(row.id, secret)}`;

  const [site, user] = await Promise.all([
    db.site.findUnique({ where: { id: session.siteId }, select: { name: true } }),
    db.user.findUnique({ where: { id: session.userId }, select: { name: true, email: true } }),
  ]);
  let emailed = false;
  try {
    const smtp = await getSendingSmtpConfig();
    if (smtp?.enabled) {
      const m = sessionInviteEmail({
        inviter: input.actor.email ?? "An administrator",
        userLabel: user?.name || user?.email || "a user",
        siteName: site?.name ?? session.host,
        canControl: input.canControl,
        untilSessionEnds,
        expiresAt,
        link,
      });
      emailed = (await sendMail({ to: email, subject: m.subject, html: m.html, text: m.text })).sent;
    }
  } catch {
    // best-effort: the link is shown to copy either way
  }

  await recordAdminAction({
    actor: input.actor,
    action: "session_invite.create",
    targetType: "session_invite",
    targetId: row.id,
    summary: `Invited ${email} to ${input.canControl ? "watch and control" : "watch"} a live session on ${site?.name ?? session.host}`,
    metadata: { sessionId: session.sessionId, siteId: session.siteId, sessionUserId: session.userId, email, canControl: input.canControl, expiresAt: expiresAt.toISOString(), untilSessionEnds, emailed },
    clientIp: input.clientIp ?? null,
  });
  return { ok: true, invite: view(row, now), link, emailed };
}

/** Withdraw an invite: the link stops working and the guest's views close. */
export async function revokeSessionInvite(sessionId: string, inviteId: string, actor: AdminActor, clientIp?: string | null): Promise<boolean> {
  const row = await db.sessionInvite.findFirst({ where: { id: inviteId, sessionId } });
  if (!row) return false;
  if (!row.revokedAt) {
    await db.sessionInvite.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedByEmail: actor.email } });
  }
  await kickViewer(sessionId, guestViewerId(row.id));
  await recordAdminAction({
    actor,
    action: "session_invite.revoke",
    targetType: "session_invite",
    targetId: row.id,
    summary: `Removed ${row.guestName ? `${row.guestName} (${row.email})` : row.email} from a live session`,
    metadata: { sessionId, email: row.email, joined: !!row.joinedAt },
    clientIp: clientIp ?? null,
  });
  return true;
}

export type LinkProblem = "invalid" | "used" | "expired" | "removed" | "ended";

export interface OpenLink {
  invite: { id: string; email: string; canControl: boolean; untilSessionEnds: boolean; expiresAt: Date; createdByEmail: string | null; sessionId: string };
  session: ActiveSession;
  siteName: string;
  userLabel: string;
}

/** The invite a link names, while it can still be used. */
export async function openLink(token: string | null | undefined): Promise<{ ok: true; link: OpenLink } | { ok: false; problem: LinkProblem }> {
  const t = parseLinkToken(token);
  if (!t) return { ok: false, problem: "invalid" };
  const row = await db.sessionInvite.findUnique({ where: { id: t.id } });
  if (!row || !secretMatches(t.secret, row.linkHash)) return { ok: false, problem: "invalid" };
  if (row.revokedAt) return { ok: false, problem: "removed" };
  if (row.joinedAt) return { ok: false, problem: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, problem: "expired" };
  const session = await findOwnSession(row.sessionId);
  if (!session || session.siteId !== row.siteId) return { ok: false, problem: "ended" };
  const [site, user] = await Promise.all([
    db.site.findUnique({ where: { id: row.siteId }, select: { name: true } }),
    db.user.findUnique({ where: { id: row.sessionUserId }, select: { name: true, email: true } }),
  ]);
  return {
    ok: true,
    link: {
      invite: { id: row.id, email: row.email, canControl: row.canControl, untilSessionEnds: row.untilSessionEnds, expiresAt: row.expiresAt, createdByEmail: row.createdByEmail, sessionId: row.sessionId },
      session,
      siteName: site?.name ?? session.host,
      userLabel: user?.name || user?.email || "a user",
    },
  };
}

/**
 * Spend a link for the guest who just signed in: once, and only while it is
 * still good. The pass secret's hash binds the invite to this browser.
 */
export async function consumeLink(inviteId: string, guest: { name: string; subject: string }, passSecret: string): Promise<boolean> {
  const r = await db.sessionInvite.updateMany({
    where: { id: inviteId, joinedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { joinedAt: new Date(), guestName: guest.name.slice(0, 120), guestSubject: guest.subject, guestTokenHash: hashSecret(passSecret) },
  });
  return r.count === 1;
}

export interface GuestRow {
  id: string;
  email: string;
  guestName: string;
  canControl: boolean;
  untilSessionEnds: boolean;
  expiresAt: Date;
  sessionId: string;
  siteId: string;
  sessionUserId: string;
  createdByEmail: string | null;
}

/** The invite a guest's pass belongs to, while it is good: joined, not removed, not expired. */
export async function guestFromPass(value: string | null | undefined): Promise<GuestRow | null> {
  const p = parseGuestPass(value);
  if (!p || p.tenantId !== currentTenantId()) return null;
  const row = await db.sessionInvite.findUnique({ where: { id: p.id } });
  if (!row || !row.joinedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  if (!secretMatches(p.secret, row.guestTokenHash)) return null;
  return {
    id: row.id, email: row.email, guestName: row.guestName || row.email, canControl: row.canControl,
    untilSessionEnds: row.untilSessionEnds, expiresAt: row.expiresAt, sessionId: row.sessionId, siteId: row.siteId,
    sessionUserId: row.sessionUserId, createdByEmail: row.createdByEmail,
  };
}

/** The data plane's question: may this pass watch this session on this site? */
export async function guestAuthz(pass: string, sessionId: string, siteId: string): Promise<{ allow: false } | { allow: true; viewerId: string; name: string; until: string }> {
  if (!(await resolvedSessionInvitesEnabled())) return { allow: false };
  const g = await guestFromPass(pass);
  if (!g || g.sessionId !== sessionId || g.siteId !== siteId) return { allow: false };
  return { allow: true, viewerId: guestViewerId(g.id), name: g.guestName, until: g.expiresAt.toISOString() };
}

/** Guests who joined a session that this recording captured, for its page. */
export async function guestsOfRecording(r: { siteId: string; userId: string; startedAt: Date; endedAt: Date }): Promise<{ name: string; email: string; joinedAt: string; canControl: boolean; invitedBy: string | null }[]> {
  const rows = await db.sessionInvite.findMany({
    where: {
      siteId: r.siteId,
      sessionUserId: r.userId,
      joinedAt: { gte: new Date(r.startedAt.getTime() - 60_000), lte: new Date(r.endedAt.getTime() + 60_000) },
    },
    orderBy: { joinedAt: "asc" },
  });
  return rows.map((x) => ({ name: x.guestName || x.email, email: x.email, joinedAt: x.joinedAt!.toISOString(), canControl: x.canControl, invitedBy: x.createdByEmail }));
}
