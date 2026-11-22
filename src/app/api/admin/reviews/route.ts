import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { createReview } from "@/lib/review/store";
import { reviewInput } from "@/lib/review/input";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async () => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const reviews = await db.accessReview.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return NextResponse.json({ reviews });
});

// Opens a review now (it lists every live grant in scope at once) or schedules it.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "approve_grants")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const v = reviewInput((await req.json().catch(() => ({}))) as Record<string, unknown>);
  if ("error" in v) return NextResponse.json(v, { status: 400 });
  if (v.siteIds.length && (await db.site.count({ where: { id: { in: v.siteIds } } })) !== v.siteIds.length) return NextResponse.json({ error: "unknown_resource" }, { status: 400 });
  const id = await createReview(v, { id: u.id, email: u.email, name: u.name });
  return NextResponse.json({ id });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
