import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can, ASSIGNABLE_ROLES } from "@/lib/auth/roles";
import { centerRoleOf, consoleRoleAllowed } from "@/lib/auth/center-role";
import { db } from "@/lib/db";
import { UserStatus } from "@/generated/prisma/enums";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

const VALID_STATUSES: string[] = Object.values(UserStatus);

export const PATCH = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const status = typeof body.status === "string" ? body.status : undefined;
  const role = typeof body.role === "string" ? body.role : undefined;

  if (!status && !role) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  // Validate status if provided
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  // Self-disable guard: risk of locking out the last admin account.
  if (status !== undefined && id === admin.id && status === "DISABLED") {
    return NextResponse.json({ error: "cannot_disable_self" }, { status: 403 });
  }

  // Validate and apply role if provided
  if (role !== undefined) {
    if (!ASSIGNABLE_ROLES.includes(role as (typeof ASSIGNABLE_ROLES)[number])) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
    if (id === admin.id) {
      return NextResponse.json({ error: "cannot_change_own_role" }, { status: 403 });
    }
  }

  const target = await db.user.findUnique({ where: { id }, select: { id: true, centerRole: true } });
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // A user the centre manages: status follows the organisation membership
  // (lib/auth/center-role.ts), and the role may only be narrowed under the
  // centre's ceiling -- never raised past it, never made a vendor.
  if (target.centerRole && status !== undefined) {
    return NextResponse.json({ error: "managed_by_center" }, { status: 403 });
  }
  if (target.centerRole && role !== undefined && !consoleRoleAllowed(centerRoleOf(target.centerRole), role)) {
    return NextResponse.json({ error: "center_role_ceiling" }, { status: 403 });
  }

  const updateData: Record<string, unknown> = {};
  if (status !== undefined) {
    updateData.status = status as UserStatus;
  }
  if (role !== undefined) {
    updateData.role = role as (typeof ASSIGNABLE_ROLES)[number];
  }

  await db.user.update({ where: { id }, data: updateData });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "user.update",
    targetType: "user", targetId: id,
    summary: `Updated user ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  if (id === admin.id) return NextResponse.json({ error: "cannot_delete_self" }, { status: 403 });

  const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true, centerRole: true } });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.role === "ADMIN") return NextResponse.json({ error: "cannot_delete_admin" }, { status: 403 });
  // Leaving the organisation happens on the Captivo account page; deleting
  // the row here would only have the person re-join on their next sign-in.
  if (target.centerRole) return NextResponse.json({ error: "managed_by_center" }, { status: 403 });

  // Cascades Passkey/TotpSecret/Session/own-AccessGrant; SetNulls the creator/
  // approver attribution on other users' invites/grants; AuditEvent +
  // SessionRecording (no relation) are untouched.
  await db.user.delete({ where: { id } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "user.delete",
    targetType: "user", targetId: id,
    summary: `Deleted user ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
