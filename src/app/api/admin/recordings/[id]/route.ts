import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { appendAuditEvents } from "@/lib/audit/append";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { requestErasure } from "@/lib/recording/erasure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withTenantRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({
    where: { id },
    select: { id: true, siteId: true, userId: true, host: true, startedAt: true, eventCount: true, bytes: true },
  });
  if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Resolve the vendor's email for a human-readable audit reason.
  const vendor = await db.user.findUnique({ where: { id: rec.userId }, select: { email: true } });

  // The bytes are on the customer's connector, so this is a REQUEST, not a delete.
  // Removing the row here would orphan those bytes forever: nothing would be left to
  // tell the connector which recording to erase. The row goes when the connector
  // confirms; see src/lib/recording/erasure.ts.
  await requestErasure(id);

  // Audit the deletion in the tamper-evident chain. Best-effort: the delete is
  // the primary action, so an audit failure is logged but does not fail the call.
  try {
    await appendAuditEvents([
      {
        userId: admin.id,
        siteId: rec.siteId,
        host: "manager",
        method: "DELETE",
        path: `/admin/recordings/${id}`,
        status: 200,
        decision: "ALLOW",
        reason: `Requested erasure of session recording (vendor ${vendor?.email ?? rec.userId}, ${rec.eventCount} events, ${rec.bytes} bytes, started ${rec.startedAt.toISOString()}); the content is on the customer\u0027s connector and is removed when that connector confirms`,
        clientIp: clientIp(req.headers),
        userAgent: req.headers.get("user-agent") ?? undefined,
      },
    ]);
  } catch (err) {
    console.error("[recordings/delete] audit append failed:", err);
  }

  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "recording.erasure_requested",
    targetType: "recording", targetId: id,
    summary: `Requested erasure of recording ${id} (applied when its connector confirms)`,
    clientIp: clientIp(req.headers) ?? null,
  });
  // 202, not 200: accepted and queued. An offline connector delays the erasure, and
  // saying "ok" would be a compliance claim the system cannot yet support.
  return NextResponse.json(
    { ok: true, status: "erasure_pending", detail: "the recording is erased when its connector next connects" },
    { status: 202 }
  );
});
