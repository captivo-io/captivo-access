import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { listAuditEvents } from "@/lib/audit/query";
import { parseAuditFilter } from "@/lib/audit/filter";
import { withTenantRoute } from "@/lib/tenant/request";
import { auditHistogram } from "@/lib/audit/histogram";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export const GET = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "read_console")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const filter = parseAuditFilter(req.nextUrl.searchParams, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
  // The first page of a ranged view also carries the time-range chart.
  const wantHistogram = req.nextUrl.searchParams.get("histogram") === "1" && filter.from && filter.to && filter.offset === 0;
  const [{ rows, total }, histogram] = await Promise.all([
    listAuditEvents(filter),
    wantHistogram ? auditHistogram({ ...filter, from: filter.from!, to: filter.to! }) : null,
  ]);

  return NextResponse.json({ rows, total, ...(histogram ? { histogram } : {}) });
});
