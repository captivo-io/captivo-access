import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { MAX_DESTINATIONS } from "@/lib/logforward/config";
import { destinationFromBody } from "@/lib/logforward/api";
import { startCursors } from "@/lib/logforward/cursor";
import { pumpSoon } from "@/lib/logforward/pump";

export const runtime = "nodejs";

/** Adds a log destination. `{ ...fields, backfill?: "24h" }`: without backfill it starts with the next record. */
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if ((await db.logDestination.count()) >= MAX_DESTINATIONS) return NextResponse.json({ error: "too_many" }, { status: 400 });
  const r = await destinationFromBody(body, null);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });

  const since = body.backfill === "24h" ? new Date(Date.now() - 24 * 3600_000) : null;
  const created = await db.logDestination.create({ data: { ...r.data, ...(await startCursors(since)) }, select: { id: true } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.log_destination_create",
    targetType: "log_destination",
    targetId: created.id,
    summary: `Added log destination ${r.data.name} (${r.data.kind === "syslog" ? `syslog ${r.data.transport} ${r.data.host}:${r.data.port}` : r.data.kind})`,
    clientIp: clientIp(req.headers) ?? null,
  });
  if (since) pumpSoon({ force: true });
  return NextResponse.json({ ok: true, id: created.id });
});
