import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { contentLengthExceeds } from "@/lib/request-limits";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { recordingEnabled } from "@/lib/recording/enabled";
import { requireDataplaneSecret, resolveTenantBySite, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dataplaneAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

interface IngestBody {
  userId?: string;
  siteId?: string;
  host?: string;
  recordingKey?: string;
  seq?: number;
  bytes?: number;
  /** "rrweb" | "guac" | "video" -- which player can replay this recording. */
  format?: string;
  /** "ssh" | "rdp" | "vnc" for gateway sessions; absent for web. */
  protocol?: string;
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as IngestBody;
  return resolveTenantBySite(body.siteId ?? "");
}

async function handler(req: NextRequest) {
  if (!dataplaneAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!recordingEnabled()) return NextResponse.json({ error: "not found" }, { status: 403 });
  if (contentLengthExceeds(req, 16 << 20)) return new NextResponse(null, { status: 413 });

  try {
    const body = (await req.json().catch(() => ({}))) as IngestBody;
    const recordingKey = body.recordingKey;
    if (!recordingKey) return new NextResponse(null, { status: 204 });

    // INDEX ONLY. The bytes were written to the customer's own connector by the
    // dataplane (dataplane/recrrweb.go); what arrives here is {recordingKey, seq,
    // bytes}. Never accept or store an event payload again -- that is the central
    // copy connector-local recordings removed, and it would look correct.
    const bytes = typeof body.bytes === "number" && body.bytes >= 0 ? body.bytes : 0;
    // The format decides which player the UI offers, so it has to reach the index.
    // Defaults to RRWEB because that is the only source that omitted it historically.
    const format =
      body.format === "guac" ? "GUAC" : body.format === "video" ? "VIDEO" : "RRWEB";

    await db.$transaction(async (tx) => {
      await tx.sessionRecording.upsert({
        where: { tenantId_recordingKey: { tenantId: currentTenantId(), recordingKey } },
        create: {
          recordingKey,
          userId: body.userId ?? "",
          siteId: body.siteId ?? "",
          host: body.host ?? "",
          eventCount: 1,
          bytes,
          format,
          protocol: body.protocol || null,
          // Encrypted, but with the CONNECTOR's key, which the control plane does
          // not hold. Kept true so replay knows the payload is sealed.
          encrypted: true,
          lastEventAt: new Date(),
        },
        update: {
          eventCount: { increment: 1 },
          bytes: { increment: bytes },
          lastEventAt: new Date(),
        },
      });
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    // Best-effort: recording must never throw — log server-side and return a
    // generic response so nothing internal leaks to the data-plane caller.
    console.error("[recording/ingest] failed to store batch:", err);
    return new NextResponse(null, { status: 500 });
  }
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
