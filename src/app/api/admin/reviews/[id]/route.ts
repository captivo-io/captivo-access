import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { cancelReview } from "@/lib/review/store";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cancels an open or scheduled review: nothing it recorded is applied.
export const DELETE = withTenantRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "approve_grants")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const ok = await cancelReview(id, { id: u.id, email: u.email, name: u.name });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_open" }, { status: 409 });
});
