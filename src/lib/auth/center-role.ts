import type { Role, UserStatus } from "@/generated/prisma/enums";
import { accessRoleForGrant } from "./oidc";

/**
 * The centre's word on a console user, applied at EVERY Captivo ID sign-in.
 *
 * Until 2.6.0 the organisation role travelled into the console once, when
 * the user row was created, and never again: an owner who promoted a member
 * at Captivo ID saw nothing change here, and a member removed there kept
 * signing in. The rule since then is one sentence: the Captivo ID role is
 * the organisation's role, and the console follows it.
 *
 *  - Owner and admin of the organisation run the workspace (ADMIN); a member
 *    uses it (STAFF).
 *  - The console may NARROW a role (an organisation admin can be made an
 *    OPERATOR or AUDITOR here) but never raise it past the centre's ceiling:
 *    a member of the organisation is never a console ADMIN. An organisation
 *    member is never a VENDOR either -- vendors are third parties invited
 *    from the console, with passkeys and no Captivo account.
 *  - A change of role at the centre resets the console role to the mapped
 *    one; an unchanged centre role leaves the console's own narrowing alone.
 *  - A user the centre manages (`centerRole` set) whose token no longer
 *    carries a grant for this tenant's organisation was removed there, and
 *    is refused and disabled here.
 *
 * `centerRole` on the user row is the last organisation role the centre
 * reported; null means the centre never spoke about this user (a passkey or
 * directory account), and such a user is never refused by this rule.
 *
 * PURE: the callback decides with it and writes what it returns.
 */
export type CenterRole = "OWNER" | "ADMIN" | "MEMBER";

/** The organisation role as stored: anything the centre adds later reads as a member. */
export function centerRoleOf(role: unknown): CenterRole {
  return role === "OWNER" || role === "ADMIN" ? role : "MEMBER";
}

/** The console roles an organisation member may hold under a centre role. */
export function consoleRolesFor(centerRole: CenterRole): Role[] {
  return centerRole === "MEMBER" ? ["OPERATOR", "AUDITOR", "STAFF"] : ["ADMIN", "OPERATOR", "AUDITOR", "STAFF"];
}

export function consoleRoleAllowed(centerRole: CenterRole, role: string): boolean {
  return (consoleRolesFor(centerRole) as string[]).includes(role);
}

export type Reconciled =
  | { outcome: "unchanged" }
  /** The centre manages this user and no longer grants this tenant's organisation. */
  | { outcome: "revoked" }
  | { outcome: "update"; role: Role; centerRole: CenterRole; status: "ACTIVE" };

export function reconcileCenterRole(
  user: { role: Role; centerRole: string | null; status: UserStatus },
  grantRole: unknown,
): Reconciled {
  // Platform staff are not organisation members of anything.
  if (user.role === "PLATFORM") return { outcome: "unchanged" };
  if (grantRole === null || grantRole === undefined) {
    return user.centerRole ? { outcome: "revoked" } : { outcome: "unchanged" };
  }
  const centerRole = centerRoleOf(grantRole);
  // The centre's first word about a local account counts as a change too:
  // from here on the organisation's role is the role.
  const changed = user.centerRole !== centerRole;
  const role: Role = changed || !consoleRoleAllowed(centerRole, user.role) ? accessRoleForGrant(centerRole) : user.role;
  if (role === user.role && user.centerRole === centerRole && user.status === "ACTIVE") return { outcome: "unchanged" };
  return { outcome: "update", role, centerRole, status: "ACTIVE" };
}
