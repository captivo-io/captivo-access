import { db } from "@/lib/db";
import { columnsFor, type ProfileSettings } from "@/lib/policy/profiles";

// Writes a profile's settings onto the resources that follow it. See profiles.ts for why the
// columns are written through instead of resolved at session time.

type ProfileRow = ProfileSettings & { id: string };

/** Rewrite the settings of every resource that follows this profile (after the profile changed). Returns how many. */
export async function reapplyProfile(profileId: string): Promise<number> {
  const p = await db.policyProfile.findUnique({ where: { id: profileId } });
  if (!p) return 0;
  const sites = await db.site.findMany({ where: { policyProfileId: profileId }, select: { id: true, accessMode: true } });
  for (const s of sites) {
    const data = columnsFor(p as ProfileRow, s.accessMode);
    if (Object.keys(data).length) await db.site.update({ where: { id: s.id }, data });
  }
  return sites.length;
}

export type ChoiceError = "unknown_profile" | "unknown_command_list";

/** Whether the profile and list a request names exist: checked BEFORE the resource is saved, so a bad id leaves nothing half done. */
export async function checkPolicyChoices(choice: { policyProfileId?: unknown; commandListId?: unknown }): Promise<ChoiceError | null> {
  const p = choice.policyProfileId;
  if (typeof p === "string" && p && !(await db.policyProfile.findUnique({ where: { id: p }, select: { id: true } }))) return "unknown_profile";
  const l = choice.commandListId;
  if (typeof l === "string" && l && !(await db.commandList.findUnique({ where: { id: l }, select: { id: true } }))) return "unknown_command_list";
  return null;
}

/**
 * A resource's choice of profile and command list, applied after the resource itself was saved.
 * `policyProfileId` and `commandListId` are only acted on when the body names them (undefined:
 * untouched). A profile governs the list too, so a list is picked on its own only without one.
 */
export async function applyPolicyChoices(siteId: string, choice: { policyProfileId?: unknown; commandListId?: unknown }): Promise<ChoiceError | null> {
  const hasProfile = choice.policyProfileId !== undefined;
  const hasList = choice.commandListId !== undefined;
  if (!hasProfile && !hasList) return null;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { accessMode: true, policyProfileId: true } });
  if (!site) return null;
  const profileId = hasProfile ? (typeof choice.policyProfileId === "string" && choice.policyProfileId ? choice.policyProfileId : null) : site.policyProfileId;
  if (profileId) {
    const p = await db.policyProfile.findUnique({ where: { id: profileId } });
    if (!p) return "unknown_profile";
    await db.site.update({ where: { id: siteId }, data: { policyProfileId: profileId, ...columnsFor(p as ProfileRow, site.accessMode) } });
    return null;
  }
  const data: { policyProfileId?: null; commandListId?: string | null } = {};
  if (hasProfile) data.policyProfileId = null;
  if (hasList) {
    const id = typeof choice.commandListId === "string" && choice.commandListId ? choice.commandListId : null;
    if (id && !(await db.commandList.findUnique({ where: { id }, select: { id: true } }))) return "unknown_command_list";
    data.commandListId = id;
  }
  if (Object.keys(data).length) await db.site.update({ where: { id: siteId }, data });
  return null;
}
