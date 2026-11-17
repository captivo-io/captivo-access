import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { listAdminAuditEvents, parseAdminFilter } from "@/lib/audit/admin-query";
import { withTenantRoute } from "@/lib/tenant/request";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

export const GET = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { rows, total } = await listAdminAuditEvents(parseAdminFilter(req.nextUrl.searchParams, DEFAULT_LIMIT, MAX_LIMIT));
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, seq: r.seq?.toString() ?? null, timestamp: r.timestamp.toISOString() })),
    total,
  });
});
