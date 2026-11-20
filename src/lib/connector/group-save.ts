import { db } from "@/lib/db";
import { repointGroupSites, type GroupMemberInput } from "@/lib/connector/groups";
import { sealLegacyCredentials } from "@/lib/vault/store";

export class GroupSaveError extends Error {}

/**
 * Creates (id null) or replaces a group's name and members, keeping its
 * resources on a member in service. Members must be this tenant's connectors
 * and not revoked.
 */
export async function saveConnectorGroup(id: string | null, name: string, members: GroupMemberInput[]): Promise<string> {
  const ids = members.map((m) => m.connectorId);
  const found = await db.connector.findMany({ where: { id: { in: ids }, status: { not: "REVOKED" } }, select: { id: true } });
  if (found.length !== ids.length) throw new GroupSaveError("connector_not_found");
  const groupId = await db.$transaction(async (tx) => {
    const clash = await tx.connectorGroup.findFirst({ where: { name, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
    if (clash) throw new GroupSaveError("name_taken");
    const g = id
      ? await tx.connectorGroup.update({ where: { id }, data: { name }, select: { id: true } })
      : await tx.connectorGroup.create({ data: { name }, select: { id: true } });
    await tx.connectorGroupMember.deleteMany({ where: { groupId: g.id, connectorId: { notIn: ids } } });
    for (const m of members) {
      await tx.connectorGroupMember.upsert({
        where: { groupId_connectorId: { groupId: g.id, connectorId: m.connectorId } },
        create: { groupId: g.id, connectorId: m.connectorId, standby: m.standby },
        update: { standby: m.standby },
      });
    }
    await repointGroupSites(tx, g.id);
    return g.id;
  });
  // Legacy (server-encrypted) secrets of the group's resources: sealed now that
  // the members are known, once every member has a key.
  for (const cid of ids) await sealLegacyCredentials({ connectorId: cid }).catch((e) => console.error("vault: sealing legacy secrets failed", e));
  return groupId;
}
