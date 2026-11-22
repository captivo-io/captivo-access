import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { csvEscape } from "@/lib/audit/query";
import { reviewToCsv } from "@/lib/review/plan";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const r = await db.accessReview.findUnique({ where: { id }, include: { items: { orderBy: [{ siteName: "asc" }, { userLabel: "asc" }] } } });
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "access-review";
  return new NextResponse(reviewToCsv(r.items, csvEscape), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${slug}.csv"` },
  });
});
