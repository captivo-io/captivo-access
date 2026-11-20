import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

// Connector groups (src/lib/connector/route.ts routes their sessions). A group
// resource keeps Site.connectorId pointing at one live member, so everything
// that needs "the" connector (tunnel URL in the console, older code paths, the
// cascade when a lone connector is deleted) keeps working; these helpers keep
// that invariant whenever a group or a connector changes.

type Tx = Prisma.TransactionClient | typeof db;

export const GROUP_NAME_MAX = 60;
export const GROUP_MEMBERS_MAX = 16;

export type GroupMemberInput = { connectorId: string; standby: boolean };

/** Validates a group's name and members from a request body. */
export function parseGroupInput(body: unknown): { name: string; members: GroupMemberInput[] } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > GROUP_NAME_MAX) return { error: "invalid_name" };
  if (!Array.isArray(b.members)) return { error: "invalid_members" };
  const seen = new Set<string>();
  const members: GroupMemberInput[] = [];
  for (const raw of b.members) {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (typeof m.connectorId !== "string" || !m.connectorId || m.connectorId.length > 64) return { error: "invalid_members" };
    if (seen.has(m.connectorId)) continue;
    seen.add(m.connectorId);
    members.push({ connectorId: m.connectorId, standby: m.standby === true });
  }
  if (members.length === 0) return { error: "no_members" };
  if (members.length > GROUP_MEMBERS_MAX) return { error: "too_many_members" };
  if (members.every((m) => m.standby)) return { error: "no_active_member" };
  return { name, members };
}

/** The member a group resource's Site.connectorId points at: the first active one still in service, else any. */
export async function standInMember(tx: Tx, groupId: string, exceptConnectorId?: string): Promise<string | null> {
  const members = await tx.connectorGroupMember.findMany({
    where: { groupId, connector: { status: { not: "REVOKED" } }, ...(exceptConnectorId ? { connectorId: { not: exceptConnectorId } } : {}) },
    orderBy: [{ standby: "asc" }, { createdAt: "asc" }],
    select: { connectorId: true },
    take: 1,
  });
  return members[0]?.connectorId ?? null;
}

/**
 * Points every resource of the group whose Site.connectorId is no longer a
 * member in service at one that is. Run after a group's members change and
 * before a connector is revoked or deleted. Resources left with no member are
 * reported, not changed.
 */
export async function repointGroupSites(tx: Tx, groupId: string, leavingConnectorId?: string): Promise<{ repointed: number; stranded: number }> {
  const members = await tx.connectorGroupMember.findMany({
    where: { groupId, connector: { status: { not: "REVOKED" } }, ...(leavingConnectorId ? { connectorId: { not: leavingConnectorId } } : {}) },
    select: { connectorId: true },
  });
  const inService = members.map((m) => m.connectorId);
  const stray = await tx.site.count({ where: { connectorGroupId: groupId, connectorId: { notIn: inService } } });
  if (stray === 0) return { repointed: 0, stranded: 0 };
  const to = await standInMember(tx, groupId, leavingConnectorId);
  if (!to) return { repointed: 0, stranded: stray };
  const res = await tx.site.updateMany({ where: { connectorGroupId: groupId, connectorId: { notIn: inService } }, data: { connectorId: to } });
  return { repointed: res.count, stranded: 0 };
}

/** Before a connector leaves service (revoke, delete): move its group resources onto another member. */
export async function releaseConnectorFromGroups(tx: Tx, connectorId: string): Promise<void> {
  const memberships = await tx.connectorGroupMember.findMany({ where: { connectorId }, select: { groupId: true } });
  for (const m of memberships) await repointGroupSites(tx, m.groupId, connectorId);
}

export type ConnectorChoice = { connectorId: string; connectorGroupId: string | null };

/**
 * A resource form's connector field: a connector, or a group (body.connectorGroupId),
 * in which case connectorId becomes the group's stand-in member.
 */
export async function resolveConnectorChoice(body: Record<string, unknown>): Promise<ConnectorChoice | { error: string }> {
  const groupId = typeof body.connectorGroupId === "string" ? body.connectorGroupId.trim() : "";
  if (groupId) {
    const g = await db.connectorGroup.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!g) return { error: "group_not_found" };
    const stand = await standInMember(db, g.id);
    if (!stand) return { error: "group_empty" };
    return { connectorId: stand, connectorGroupId: g.id };
  }
  const connectorId = typeof body.connectorId === "string" ? body.connectorId.trim() : "";
  if (!connectorId) return { error: "connector_name_required" };
  return { connectorId, connectorGroupId: null };
}
