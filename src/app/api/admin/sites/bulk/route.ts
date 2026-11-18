import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { parseBulk, planMove } from "@/lib/site/bulk";
import { sealLegacyCredentials } from "@/lib/vault/store";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

// The Resources page's bulk bar: delete several resources (their grants go
// with them) or move them to another connector. One audit entry per resource,
// as the single delete and edit write.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const input = parseBulk(await req.json().catch(() => null));
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });

  const sites = await db.site.findMany({
    where: { id: { in: input.ids } },
    select: { id: true, name: true, accessMode: true, connectorId: true, vaultCredential: { select: { sealedTo: true } } },
  });
  if (sites.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ip = clientIp(req.headers) ?? null;
  const actor = { id: admin.id, email: admin.email };

  if (input.action === "delete") {
    const ids = sites.map((s) => s.id);
    await db.site.deleteMany({ where: { id: { in: ids } } }); // cascades each Site's AccessGrant rows
    for (const s of sites) {
      await recordAdminAction({ actor, action: "resource.delete", targetType: "resource", targetId: s.id, summary: `Deleted resource ${s.id}`, clientIp: ip });
    }
    return NextResponse.json({ ok: true, deleted: ids.length });
  }

  const target = await db.connector.findUnique({ where: { id: input.connectorId }, select: { id: true, name: true, status: true } });
  if (!target || target.status === "REVOKED") return NextResponse.json({ error: "connector_not_found" }, { status: 400 });

  const plan = planMove(sites.map((s) => ({ id: s.id, accessMode: s.accessMode, connectorId: s.connectorId, sealed: !!s.vaultCredential?.sealedTo })), target.id);
  if (plan.move.length) {
    await db.site.updateMany({ where: { id: { in: plan.move } }, data: { connectorId: target.id } });
    for (const s of sites.filter((x) => plan.move.includes(x.id))) {
      // A legacy server-side secret is sealed to the new connector right away, as an edit does.
      if (s.accessMode === "GATEWAY") await sealLegacyCredentials({ siteId: s.id });
      await recordAdminAction({ actor, action: "resource.update", targetType: "resource", targetId: s.id, summary: `Moved resource "${s.name}" to connector "${target.name}"`, clientIp: ip });
    }
  }
  return NextResponse.json({ ok: true, moved: plan.move.length, sealed: plan.sealed.length, already: plan.already.length });
});
