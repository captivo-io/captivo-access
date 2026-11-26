import { db } from "@/lib/db";
import type { Role } from "@/generated/prisma/enums";
import { getDirectoryConfig, getDirectoryBindPassword } from "@/lib/directory/config";
import { resolveDirectoryUser } from "@/lib/connector/dataplane";
import { listGroupMappingsLite } from "@/lib/directory/mappings";
import { computeReconcile, planGrantChanges, type ReconcileDecision } from "@/lib/directory/reconcile";
import { directorySyncThrottleMs, shouldSkipSync } from "@/lib/directory/sync-throttle";
import { appendAuditEvents } from "@/lib/audit/append";

export interface DirectoryUser {
  id: string;
  email: string;
  role: Role;
  directoryManaged: boolean;
}

// syncUserAtLogin reconciles a just-authenticated user against AD group
// membership. It is called BEFORE a session is issued. Returns
// { deprovisioned: true } to reject the login. Fail-open on ANY LDAP error:
// deprovisioning happens only on a definitive AD answer.
export async function syncUserAtLogin(user: DirectoryUser): Promise<{ deprovisioned: boolean }> {
  const cfg = await getDirectoryConfig();
  if (!cfg || !cfg.enabled || !cfg.connectorId) return { deprovisioned: false };

  // Throttle: skip the (potentially slow) LDAP resolve if this user was verified
  // against AD recently — keeps most logins fast without losing enforcement.
  const throttleMs = directorySyncThrottleMs();
  if (throttleMs > 0) {
    const u = await db.user.findUnique({ where: { id: user.id }, select: { directoryLastVerifiedAt: true } });
    if (shouldSkipSync(u?.directoryLastVerifiedAt, Date.now(), throttleMs)) return { deprovisioned: false };
  }

  let resolved: { found: boolean; memberOf?: string[]; error?: string };
  try {
    const bindPassword = (await getDirectoryBindPassword()) ?? "";
    resolved = await resolveDirectoryUser({
      connectorId: cfg.connectorId,
      host: cfg.host,
      port: cfg.port,
      security: cfg.security,
      insecureSkipVerify: cfg.insecureSkipVerify,
      caCertPem: cfg.caCertPem,
      baseDN: cfg.baseDN,
      bindDN: cfg.bindDN,
      bindPassword,
      email: user.email,
    });
  } catch (err) {
    console.warn("[directory/sync] resolve threw, failing open:", err);
    return { deprovisioned: false };
  }

  // Fail-open: an error means "unknown", never "absent".
  if (resolved.error) {
    console.warn("[directory/sync] resolve error, failing open:", resolved.error);
    return { deprovisioned: false };
  }

  const mappings = await listGroupMappingsLite();
  const groups = resolved.found ? resolved.memberOf ?? [] : [];
  const decision = computeReconcile(groups, mappings, { directoryManaged: user.directoryManaged });

  if (decision.deprovision) {
    await deprovisionUser(user);
    return { deprovisioned: true };
  }

  // No mapping matched and the user is local (not directory-managed) → leave
  // alone, but stamp the verify time so the throttle can skip the next logins.
  if (decision.role === null && decision.grantSiteIds.length === 0) {
    await db.user.update({ where: { id: user.id }, data: { directoryLastVerifiedAt: new Date() } }).catch(() => {});
    return { deprovisioned: false };
  }

  await provisionUser(user, decision);
  return { deprovisioned: false };
}

async function provisionUser(user: DirectoryUser, decision: ReconcileDecision): Promise<void> {
  const current = await db.accessGrant.findMany({
    where: { userId: user.id, status: "ACTIVE", directoryManaged: true },
    select: { siteId: true },
  });
  const { toCreateSiteIds, toRevokeSiteIds } = planGrantChanges(
    current.map((g) => g.siteId),
    decision.grantSiteIds,
  );

  const roleChanged = decision.role !== null && decision.role !== user.role;
  const userData: { directoryManaged: boolean; directoryLastVerifiedAt: Date; role?: Role } = {
    directoryManaged: true,
    directoryLastVerifiedAt: new Date(),
  };
  if (roleChanged && decision.role) userData.role = decision.role;

  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: userData }),
    ...toCreateSiteIds.map((siteId) =>
      db.accessGrant.create({
        data: {
          userId: user.id,
          siteId,
          status: "ACTIVE",
          requiresApproval: false,
          directoryManaged: true,
          checkoutDenied: true,
          note: "Provisioned from AD group",
        },
      }),
    ),
    ...(toRevokeSiteIds.length
      ? [
          db.accessGrant.updateMany({
            where: { userId: user.id, status: "ACTIVE", directoryManaged: true, siteId: { in: toRevokeSiteIds } },
            data: { status: "REVOKED" },
          }),
        ]
      : []),
  ]);

  // Only audit when something actually changed — reconcile runs every login and
  // is usually a no-op for a stable user.
  if (roleChanged || toCreateSiteIds.length || toRevokeSiteIds.length) {
    await auditDirectory(
      user,
      "ALLOW",
      "directory.provision",
      `role=${decision.role ?? user.role}; +${toCreateSiteIds.length} grants, -${toRevokeSiteIds.length} grants`,
    );
  }
}

async function deprovisionUser(user: DirectoryUser): Promise<void> {
  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { status: "DISABLED", directoryLastVerifiedAt: new Date() },
    }),
    db.accessGrant.updateMany({
      where: { userId: user.id, status: "ACTIVE" },
      data: { status: "REVOKED" },
    }),
  ]);
  await auditDirectory(user, "DENY", "directory.deprovision", "removed from all mapped AD groups");
}

async function auditDirectory(
  user: DirectoryUser,
  decision: "ALLOW" | "DENY",
  path: string,
  reason: string,
): Promise<void> {
  try {
    await appendAuditEvents([
      {
        userId: user.id,
        host: "manager",
        method: "SYNC",
        path,
        status: 200,
        decision,
        reason,
      },
    ]);
  } catch (err) {
    console.error(`[directory/sync] audit append failed (${path}):`, err);
  }
}
