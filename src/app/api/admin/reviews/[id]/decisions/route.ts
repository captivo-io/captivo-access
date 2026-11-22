import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { decide, ReviewError } from "@/lib/review/store";
import { decisionInput } from "@/lib/review/input";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Records keep / revoke / limit / remove-from-group (or clears it) on items.
// Applied when the review closes; a reviewer's own access is never theirs to decide.
export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "approve_grants")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const v = decisionInput((await req.json().catch(() => ({}))) as Record<string, unknown>);
  if ("error" in v) return NextResponse.json(v, { status: 400 });
  try {
    return NextResponse.json(await decide(id, v.itemIds, v.decision, v.limitTo, { id: u.id, email: u.email, name: u.name }));
  } catch (e) {
    if (e instanceof ReviewError) return NextResponse.json({ error: e.message }, { status: e.message === "not_found" ? 404 : 409 });
    throw e;
  }
});
