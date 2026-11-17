import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Records that an admin is taking a copy of a recording, before the browser
 * fetches the video (by the same ranged requests the player uses). A recording
 * that leaves the console is in the admin chain, with who took it and when.
 */
export const POST = withTenantRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({ where: { id }, select: { format: true, videoReady: true, host: true, startedAt: true } });
  if (!rec || !(rec.format === "VIDEO" || (rec.format === "GUAC" && rec.videoReady))) {
    return NextResponse.json({ error: "not_downloadable" }, { status: 404 });
  }
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "recording.download",
    targetType: "recording", targetId: id,
    summary: `Downloaded recording ${id} (${rec.host}, started ${rec.startedAt.toISOString()})`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
