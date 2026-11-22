import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { createGrant, listGrants, revokeGrant } from "@/lib/access/grants";
import { validateSchedule, type Schedule } from "@/lib/access/schedule";
import { grantCapError } from "@/lib/access/grant-edit";
import { grantCovers, grantIsLive } from "@/lib/access/grant-cover";
import { resolvedMaxGrantDays } from "@/lib/settings/platform";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

const MAX_SITES = 50;

function parseDate(value: unknown): { ok: true; value: Date | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "approve_grants")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  // One grant per resource: `siteIds` from the grants dialog, `siteId` from older callers.
  const siteIds = [...new Set(
    (Array.isArray(body.siteIds) ? body.siteIds : [body.siteId])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean),
  )];
  if (!userId || siteIds.length === 0) {
    return NextResponse.json({ error: "user_site_required" }, { status: 400 });
  }
  if (siteIds.length > MAX_SITES) {
    return NextResponse.json({ error: "too_many_sites" }, { status: 400 });
  }

  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (!startsAt.ok || !endsAt.ok) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const capErr = grantCapError(startsAt.value, endsAt.value, new Date(), await resolvedMaxGrantDays());
  if (capErr) return NextResponse.json({ error: capErr }, { status: 400 });

  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  let schedule: Schedule | null = null;
  if (body.schedule !== undefined && body.schedule !== null) {
    const v = validateSchedule(body.schedule);
    if (!v.ok) return NextResponse.json({ error: "invalid_schedule" }, { status: 400 });
    schedule = v.schedule;
  }

  const [user, siteCount] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true } }),
    db.site.count({ where: { id: { in: siteIds } } }),
  ]);
  if (!user) {
    return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  }
  if (siteCount !== siteIds.length) {
    return NextResponse.json({ error: "invalid_site" }, { status: 400 });
  }

  // A grant the person already has that covers the whole new window makes the
  // new one pointless; refuse rather than pile up duplicates.
  const now = Date.now();
  const proposed = { startsAt: startsAt.value?.getTime() ?? null, endsAt: endsAt.value?.getTime() ?? null, recurring: schedule !== null };
  const existing = await db.accessGrant.findMany({
    where: { userId, siteId: { in: siteIds }, status: "ACTIVE" },
    select: { siteId: true, status: true, startsAt: true, endsAt: true, schedule: true, requiresApproval: true, approvedAt: true },
  });
  const covered = [...new Set(existing
    .filter((g) => grantIsLive(g, now) && grantCovers({ startsAt: g.startsAt?.getTime() ?? null, endsAt: g.endsAt?.getTime() ?? null, recurring: g.schedule !== null }, proposed, now))
    .map((g) => g.siteId))];
  if (covered.length) return NextResponse.json({ error: "already_covered", siteIds: covered }, { status: 409 });

  const ids: string[] = [];
  for (const siteId of siteIds) {
    const { id } = await createGrant({
      userId,
      siteId,
      startsAt: startsAt.value,
      endsAt: endsAt.value,
      note,
      createdById: admin.id,
      schedule,
    });
    ids.push(id);
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "grant.create",
      targetType: "grant", targetId: id,
      summary: `Created access grant ${id}`,
      metadata: { userId, siteId },
      clientIp: clientIp(req.headers) ?? null,
    });
  }
  return NextResponse.json({ id: ids[0], ids }, { status: 201 });
});

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "read_console")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const grants = await listGrants();
  return NextResponse.json({ grants });
});

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "approve_grants")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }

  await revokeGrant(id, { userId: admin.id });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "grant.revoke",
    targetType: "grant", targetId: id,
    summary: `Revoked access grant ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
