import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { parseBulk, planMove } from "@/lib/site/bulk";
import { sealLegacyCredentials, sealsOf } from "@/lib/vault/store";
import { standInMember } from "@/lib/connector/groups";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { reshareGroupSecrets } from "@/lib/vault/reshare";

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
    select: { id: true, name: true, accessMode: true, connectorId: true, connectorGroupId: true, vaultCredential: { select: { sealedTo: true, secret: true, extraSeals: true } } },
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

  // The destination: a connector, or a connector group (through its stand-in member).
  let dest: { connectorId: string; connectorGroupId: string | null; name: string; keys: string[] };
  if (input.connectorGroupId) {
    const g = await db.connectorGroup.findUnique({ where: { id: input.connectorGroupId }, select: { id: true, name: true, members: { select: { connector: { select: { status: true, vaultPublicKey: true } } } } } });
    const standIn = g ? await standInMember(db, g.id) : null;
    if (!g || !standIn) return NextResponse.json({ error: "group_not_found" }, { status: 400 });
    const keys = g.members.filter((m) => m.connector.status !== "REVOKED").map((m) => m.connector.vaultPublicKey).filter((k): k is string => !!k);
    dest = { connectorId: standIn, connectorGroupId: g.id, name: `group "${g.name}"`, keys };
  } else {
    const target = await db.connector.findUnique({ where: { id: input.connectorId }, select: { id: true, name: true, status: true, vaultPublicKey: true } });
    if (!target || target.status === "REVOKED") return NextResponse.json({ error: "connector_not_found" }, { status: 400 });
    dest = { connectorId: target.id, connectorGroupId: null, name: `connector "${target.name}"`, keys: target.vaultPublicKey ? [target.vaultPublicKey] : [] };
  }

  const plan = planMove(
    sites.map((s) => ({
      id: s.id, accessMode: s.accessMode, connectorId: s.connectorId, connectorGroupId: s.connectorGroupId,
      sealed: !!s.vaultCredential?.sealedTo, sealedKeys: s.vaultCredential ? Object.keys(sealsOf(s.vaultCredential)) : [],
    })),
    dest.connectorGroupId ? { connectorGroupId: dest.connectorGroupId, keys: dest.keys } : { connectorId: dest.connectorId, keys: dest.keys },
  );
  if (plan.move.length) {
    await db.site.updateMany({ where: { id: { in: plan.move } }, data: { connectorId: dest.connectorId, connectorGroupId: dest.connectorGroupId } });
    for (const s of sites.filter((x) => plan.move.includes(x.id))) {
      // A legacy server-side secret is sealed to the new connector right away, as an edit does.
      if (s.accessMode === "GATEWAY" || s.accessMode === "DATABASE" || s.accessMode === "KUBERNETES") await sealLegacyCredentials({ siteId: s.id });
      await recordAdminAction({ actor, action: "resource.update", targetType: "resource", targetId: s.id, summary: `Moved resource "${s.name}" to ${dest.name}`, clientIp: ip });
    }
    // Moved onto a group, a password sealed for one member is copied to the others.
    if (dest.connectorGroupId) await reshareGroupSecrets({ groupIds: [dest.connectorGroupId] }, actor).catch((e) => console.error("vault: copying secrets to the group failed", e));
  }
  return NextResponse.json({ ok: true, moved: plan.move.length, sealed: plan.sealed.length, already: plan.already.length });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
