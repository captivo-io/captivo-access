import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";

// Marks notifications read: { ids: [...] } for the rows of one incident, or
// everything when the body is empty or { all: true } (the bell sends no body).
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "read_console")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; all?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 500) : null;
  if (ids && body.all !== true) {
    if (ids.length === 0) return NextResponse.json({ ok: true });
    await db.notification.updateMany({ where: { id: { in: ids }, readAt: null }, data: { readAt: new Date() } });
    return NextResponse.json({ ok: true });
  }

  await db.notification.updateMany({
    where: { readAt: null },
    data: { readAt: new Date() },
  });

  return NextResponse.json({ ok: true });
});
