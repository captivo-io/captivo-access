import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { historyWindow } from "@/lib/portal/history";
import { withTenantRoute } from "@/lib/tenant/request";

// The week of the signed-in user's own sessions before `until` (default now).
export const GET = withTenantRoute(async (req: Request) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("until");
  const parsed = raw ? new Date(raw) : new Date();
  const until = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return NextResponse.json(await historyWindow(user.id, until));
});
