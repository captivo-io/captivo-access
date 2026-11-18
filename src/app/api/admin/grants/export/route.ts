import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { grantRows, siteTile, SITE_TILE_SELECT } from "@/lib/access/grant-rows";
import { grantsToCsv } from "@/lib/access/grant-csv";
import { csvEscape } from "@/lib/audit/query";
import { withTenantRoute } from "@/lib/tenant/request";

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [rows, users, sites] = await Promise.all([
    grantRows(new Date()),
    db.user.findMany({ select: { id: true, name: true, email: true, role: true } }),
    db.site.findMany({ select: SITE_TILE_SELECT }),
  ]);
  const csv = grantsToCsv(rows, new Map(users.map((u) => [u.id, u])), new Map(sites.map((s) => [s.id, siteTile(s)])), csvEscape);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="grants.csv"',
    },
  });
});
