import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import { countPendingGrants } from "@/lib/access/grants";
import { countUnreadNotifications } from "@/lib/notifications";
import { managerVersion } from "@/lib/version";
import { isConnectorOutdated } from "@/lib/updates/semver";
import { workspaceView } from "@/lib/mobile/views";
import type { NavCounts } from "./model";
import { canModerate, MODERATION_WAIT_MS } from "@/lib/moderation/rules";
import { resolvedModeratorRoles } from "@/lib/settings/platform";

export interface ShellWorkspace { name: string; host: string | null }

/**
 * What the sidebar counts and names, for one request. Each count is only read
 * for a role that sees it, and a failed read is a missing badge, never a
 * broken page.
 */
export async function getShellData(user: { id: string; role: Role }): Promise<{ counts: NavCounts; workspace: ShellWorkspace }> {
  const read = can(user.role, "read_console");
  const config = can(user.role, "configure");
  const grants = can(user.role, "approve_grants");
  const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const mgr = managerVersion();

  const moderator = read && canModerate(user.role, await soft(resolvedModeratorRoles(), "admins_operators" as const));
  const [pending, unread, connectors, unreachableResources, myPending, ws, reviewPending, moderationWaiting] = await Promise.all([
    grants ? soft(countPendingGrants(), 0) : 0,
    read ? soft(countUnreadNotifications(), 0) : 0,
    config ? soft(db.connector.findMany({ where: { status: { not: "REVOKED" } }, select: { version: true } }), []) : [],
    config ? soft(db.site.count({ where: { probeOk: false } }), 0) : 0,
    soft(db.accessGrant.count({ where: { userId: user.id, status: "ACTIVE", requiresApproval: true, approvedAt: null } }), 0),
    soft(workspaceView(), { name: "Captivo Access", slug: null, origin: "" }),
    grants ? soft(db.accessReviewItem.count({ where: { decision: null, review: { status: "open" }, userId: { not: user.id } } }), 0) : 0,
    moderator ? soft(db.moderationRequest.count({ where: { status: "waiting", requestedAt: { gt: new Date(Date.now() - MODERATION_WAIT_MS) }, userId: { not: user.id } } }), 0) : 0,
  ]);
  let host: string | null = null;
  try {
    host = ws.origin ? new URL(ws.origin).host : null;
  } catch {
    host = null;
  }
  return {
    counts: {
      pending,
      unread,
      reviewPending,
      outdatedConnectors: connectors.filter((c) => c.version && isConnectorOutdated(c.version, mgr)).length,
      unreachableResources,
      myPending,
      moderationWaiting,
    },
    workspace: { name: ws.slug ?? ws.name, host },
  };
}
