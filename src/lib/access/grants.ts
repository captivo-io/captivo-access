import { db } from "@/lib/db";
import { siteRoutingSelect } from "@/lib/connector/route";
import type { Schedule } from "@/lib/access/schedule";
import { classifyGrant } from "@/lib/access/evaluate";
import { grantTicketData, type GrantTicket } from "@/lib/ticketing/system";

export async function createGrant(input: {
  userId: string;
  siteId: string;
  startsAt: Date | null;
  endsAt: Date | null;
  note: string | null;
  createdById: string;
  schedule: Schedule | null;
  ticket?: GrantTicket | null;
}): Promise<{ id: string }> {
  const g = await db.accessGrant.create({
    data: {
      userId: input.userId,
      siteId: input.siteId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      note: input.note,
      requiresApproval: false,
      status: "ACTIVE",
      createdById: input.createdById,
      ...(input.schedule ? { schedule: input.schedule as object } : {}),
      ...grantTicketData(input.ticket ?? null),
    },
  });
  return { id: g.id };
}

export async function listGrants() {
  return db.accessGrant.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      requiresApproval: true,
      approvedAt: true,
      schedule: true,
      note: true,
      denyReason: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
      site: { select: { name: true, hostname: true } },
    },
  });
}

export async function revokeGrant(id: string, by?: { userId?: string | null; reason?: string | null }): Promise<void> {
  await db.accessGrant.updateMany({
    where: { id },
    data: { status: "REVOKED", revokedAt: new Date(), revokedById: by?.userId ?? null, revokeReason: by?.reason ?? null },
  });
}

export async function listUserGrants(userId: string) {
  return db.accessGrant.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      requiresApproval: true,
      approvedAt: true,
      schedule: true,
      denyReason: true,
      // The tile fields (icon, colour, logo, and the address the automatic icon reads)
      // stay on the server: callers map out only what they show.
      site: { select: { id: true, name: true, hostname: true, recordSessions: true, nativeRdp: true, nativeSsh: true, requireModerator: true, logoType: true, accessMode: true, upstreamUrl: true, iconName: true, iconColor: true, logoBg: true, ...siteRoutingSelect, vaultCredential: { select: { targetHost: true, targetPort: true, protocol: true } } } },
    },
  });
}

// A vendor's self-service access request: a grant that requires approval and is not yet
// approved (classifyGrant → pending_approval → denied until an admin approves).
export async function createAccessRequest(input: {
  userId: string;
  siteId: string;
  startsAt: Date | null;
  endsAt: Date | null;
  note: string;
  schedule: Schedule | null;
  ticket?: GrantTicket | null;
  /** Approved already, by an approved ticket on a resource that takes one as approval. */
  approvedByTicket?: boolean;
}): Promise<{ ok: true; id: string } | { ok: false; reason: "request_pending" }> {
  return db.$transaction(async (tx) => {
    // One pending request per (user, site) at a time.
    const existing = await tx.accessGrant.findFirst({
      where: {
        userId: input.userId,
        siteId: input.siteId,
        status: "ACTIVE",
        requiresApproval: true,
        approvedAt: null,
      },
      select: { id: true },
    });
    if (existing) return { ok: false as const, reason: "request_pending" as const };

    const g = await tx.accessGrant.create({
      data: {
        userId: input.userId,
        siteId: input.siteId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        note: input.note,
        requiresApproval: true,
        status: "ACTIVE",
        approvedAt: input.approvedByTicket ? new Date() : null,
        createdById: input.userId,
        ...(input.schedule ? { schedule: input.schedule as object } : {}),
        ...grantTicketData(input.ticket ?? null),
      },
    });
    return { ok: true as const, id: g.id };
  });
}

// Sites the user can still request: everything EXCEPT sites they already hold (or
// are getting) access to — an active/upcoming/pending/off-hours grant hides the
// site so they can't request a duplicate. Only revoked/denied/expired grants free
// the site to be requested again.
export async function listSitesForRequest(userId: string): Promise<{ id: string; name: string; hostname: string | null; accessMode: string; ticketMode: string | null }[]> {
  const [all, grants] = await Promise.all([
    db.site.findMany({ select: { id: true, name: true, hostname: true, accessMode: true, ticketMode: true }, orderBy: { name: "asc" } }),
    listUserGrants(userId),
  ]);
  const now = new Date();
  const done = new Set(["revoked", "denied", "expired"]);
  const held = new Set(grants.filter((g) => !done.has(classifyGrant(g, now))).map((g) => g.site.id));
  return all.filter((s) => !held.has(s.id));
}

const PENDING_WHERE = { status: "ACTIVE", requiresApproval: true, approvedAt: null } as const;

export async function listPendingGrants() {
  return db.accessGrant.findMany({
    where: PENDING_WHERE,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      note: true,
      createdAt: true,
      schedule: true,
      ticketRef: true,
      ticket: true,
      ticketVerified: true,
      user: { select: { name: true, email: true } },
      site: { select: { name: true, hostname: true } },
    },
  });
}

export async function countPendingGrants(): Promise<number> {
  return db.accessGrant.count({ where: PENDING_WHERE });
}

// Approve or deny a pending request. Conditional on the grant still being pending, so a
// double-decide (or two admins racing) is a no-op the caller reads as "not pending".
export async function decideGrant(
  id: string,
  decision: "approve" | "deny",
  adminId: string,
  reason?: string | null,
): Promise<number> {
  const now = new Date();
  const data =
    decision === "approve"
      ? { approvedAt: now, approvedById: adminId }
      : { status: "DENIED" as const, approvedAt: now, approvedById: adminId, denyReason: reason ?? null };
  const res = await db.accessGrant.updateMany({ where: { id, ...PENDING_WHERE }, data });
  return res.count;
}

export async function listUserRequests(userId: string) {
  return db.accessGrant.findMany({
    where: { userId, requiresApproval: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, createdAt: true, startsAt: true, endsAt: true,
      status: true, approvedAt: true, approvedById: true, denyReason: true, note: true, schedule: true,
      ticketRef: true, ticket: true, ticketVerified: true, revokeReason: true,
      site: { select: { name: true, hostname: true, accessMode: true } },
    },
  });
}
