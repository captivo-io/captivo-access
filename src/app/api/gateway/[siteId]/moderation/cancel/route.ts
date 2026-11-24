import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { cancelRequest } from "@/lib/moderation/requests";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The page left while waiting (navigator.sendBeacon only POSTs): withdraw the request.
export const POST = withTenantRoute(async (req: Request) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (id) await cancelRequest(id, user.id);
  return NextResponse.json({ ok: true });
});
