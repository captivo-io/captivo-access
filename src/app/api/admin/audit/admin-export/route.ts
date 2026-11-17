import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { listAdminAuditEvents, adminToCsv, parseAdminFilter } from "@/lib/audit/admin-query";
import { csvEscape } from "@/lib/audit/query";
import { withTenantRoute } from "@/lib/tenant/request";

const EXPORT_LIMIT = 10000;

export const GET = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { rows } = await listAdminAuditEvents({ ...parseAdminFilter(req.nextUrl.searchParams, EXPORT_LIMIT, EXPORT_LIMIT), offset: 0 });
  return new NextResponse(adminToCsv(rows, csvEscape), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="admin-audit.csv"',
    },
  });
});
