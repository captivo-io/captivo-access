import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { closeReview } from "@/lib/review/store";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Closes a review before its due date and applies it.
export const POST = withTenantRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "approve_grants")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const summary = await closeReview(id, { id: u.id, email: u.email, name: u.name });
  return summary ? NextResponse.json({ ok: true, summary }) : NextResponse.json({ error: "not_open" }, { status: 409 });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
