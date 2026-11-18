import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { dismissOnboarding } from "@/lib/settings/platform";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Hide setup" and "Go to console" on the Console setup card: hidden for the
// whole tenant, so other admins land on the regular Console too.
export const POST = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await dismissOnboarding();
  return NextResponse.json({ ok: true });
});
