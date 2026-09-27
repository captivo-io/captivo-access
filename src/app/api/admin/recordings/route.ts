import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { parseRecordingFilter } from "@/lib/recording/filter";
import { listRecordings } from "@/lib/recording/query";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const filter = parseRecordingFilter(req.nextUrl.searchParams, { defaultLimit: 50, maxLimit: 200 });
  const { rows, total, tooBroad, partial, unreachableConnectors } = await listRecordings(filter);

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const siteIds = [...new Set(rows.map((r) => r.siteId))];
  const users = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
  const sites = new Map((await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } })).map((s) => [s.id, s]));

  const out = rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    lastEventAt: r.lastEventAt.toISOString(),
    host: r.host,
    bytes: r.bytes,
    userId: r.userId,
    userName: users.get(r.userId)?.name ?? null,
    userEmail: users.get(r.userId)?.email ?? null,
    siteId: r.siteId,
    siteName: sites.get(r.siteId)?.name ?? null,
    format: r.format,
    protocol: r.protocol,
  }));

  // partial is not cosmetic: it is the difference between "nothing matched" and "we
  // could not look". A command search now runs on the connectors that hold the text,
  // so an offline one means the answer is incomplete.
  return NextResponse.json({
    rows: out,
    total,
    tooBroad: tooBroad ?? false,
    partial: partial ?? false,
    unreachableConnectors: unreachableConnectors ?? [],
  });
});
