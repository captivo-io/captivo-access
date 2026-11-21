import { NextRequest, NextResponse } from "next/server";
import { releaseConnectorFromGroups } from "@/lib/connector/groups";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { canDeleteConnector } from "@/lib/connector/deletion";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

// Body { withResources: true, confirmName } also deletes the revoked
// connector's resources (and their grants) in the same transaction.
export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { withResources?: unknown; confirmName?: unknown };
  // Connector-group resources it stood in for move to another member, so only
  // its own resources (and those of groups it was the last member of) remain.
  await releaseConnectorFromGroups(db, id);
  const connector = await db.connector.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, sites: { select: { id: true } } },
  });
  if (!connector) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const withSites = body.withResources === true ? { name: connector.name, confirmName: body.confirmName } : undefined;
  const check = canDeleteConnector({ status: connector.status, siteCount: connector.sites.length, withSites });
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: check.reason === "confirm_mismatch" ? 400 : 409 });

  const siteIds = withSites ? connector.sites.map((s) => s.id) : [];
  await db.$transaction(async (tx) => {
    if (siteIds.length) await tx.site.deleteMany({ where: { id: { in: siteIds } } }); // cascades their AccessGrant rows
    await tx.connector.delete({ where: { id } });
  });
  const ip = clientIp(req.headers) ?? null;
  const actor = { id: admin.id, email: admin.email };
  for (const siteId of siteIds) {
    await recordAdminAction({ actor, action: "resource.delete", targetType: "resource", targetId: siteId, summary: `Deleted resource ${siteId}`, clientIp: ip });
  }
  await recordAdminAction({
    actor,
    action: "connector.delete",
    targetType: "connector", targetId: id,
    summary: siteIds.length ? `Deleted connector ${id} with its ${siteIds.length} resource${siteIds.length === 1 ? "" : "s"}` : `Deleted connector ${id}`,
    clientIp: ip,
  });
  return NextResponse.json({ ok: true, deletedResources: siteIds.length });
});
