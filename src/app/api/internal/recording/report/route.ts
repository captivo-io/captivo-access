import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { requireDataplaneSecret, resolveTenantByConnector, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantByConnector(typeof body.connectorId === "string" ? body.connectorId : "");
}

type Item = { tenantId: string; recordingKey: string; video: boolean; durationMs: number; storedBytes: number };

function items(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.tenantId !== "string" || typeof o.recordingKey !== "string" || !o.recordingKey) return [];
    // Both columns are 32-bit integers.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 2 ** 31 - 1) : 0);
    return [{ tenantId: o.tenantId, recordingKey: o.recordingKey, video: o.video === true, durationMs: num(o.durationMs), storedBytes: num(o.storedBytes) }];
  });
}

// A connector's recording worker reported what it changed after a session ended
// (relayed by the data plane): an RDP/VNC recording turned into a video, a
// measured duration, what the disk now holds after compression. The index
// follows, so the player picks the video and the console shows the real size.
// Answering 2xx is the ack: the connector stops resending these items. Items
// this connector does not hold (another tenant's, another connector's site) are
// acknowledged and ignored, so they are not resent forever.
async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  const tenantId = currentTenantId();
  let updated = 0;
  for (const it of items(body.items)) {
    if (it.tenantId !== tenantId) continue;
    const rec = await db.sessionRecording.findUnique({
      where: { tenantId_recordingKey: { tenantId, recordingKey: it.recordingKey } },
      select: { id: true, siteId: true, format: true },
    });
    if (!rec) continue;
    const site = await db.site.findUnique({ where: { id: rec.siteId }, select: { connectorId: true } });
    if (!site || site.connectorId !== connectorId) continue;
    await db.sessionRecording.update({
      where: { id: rec.id },
      data: {
        reportedAt: new Date(),
        ...(rec.format === "GUAC" ? { videoReady: it.video } : {}),
        ...(it.durationMs > 0 ? { durationMs: it.durationMs } : {}),
        ...(it.storedBytes > 0 ? { bytes: it.storedBytes } : {}),
      },
    });
    updated++;
  }
  return NextResponse.json({ ok: true, updated });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
