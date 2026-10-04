import { NextRequest, NextResponse } from "next/server";
import { confirmErasures, trimIndexAfterRetention } from "@/lib/recording/erasure";
import { resolvedRecordingRetentionDays } from "@/lib/settings/platform";
import { appendAuditEvents } from "@/lib/audit/append";
import { requireDataplaneSecret, resolveTenantByConnector, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantByConnector(typeof body.connectorId === "string" ? body.connectorId : "");
}

// A connector reported, over its control stream (relayed by the data-plane), what
// a pushed recording policy actually did: which erasures it completed and whether
// a retention sweep removed anything. Now — and only now — the index rows go, so
// the console never advertises a recording whose bytes are gone, and an accepted
// erasure is marked done only after the connector confirms it.
async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const purgedKeys = Array.isArray(body.purgedKeys) ? body.purgedKeys.filter((k): k is string => typeof k === "string") : [];
  const retentionRemoved = typeof body.retentionRemoved === "number" ? body.retentionRemoved : 0;

  let confirmed = 0;
  if (purgedKeys.length > 0) confirmed = await confirmErasures(purgedKeys);

  let trimmed = 0;
  if (retentionRemoved > 0) {
    const days = await resolvedRecordingRetentionDays();
    if (days > 0) trimmed = await trimIndexAfterRetention(days);
  }

  if (confirmed > 0 || trimmed > 0) {
    try {
      await appendAuditEvents([
        {
          host: "manager",
          method: "DELETE",
          path: "/api/internal/recording/erasure-ack",
          status: 200,
          decision: "ALLOW",
          reason: `Connector confirmed recording erasure: ${confirmed} requested erasure(s) completed${trimmed > 0 ? `, ${trimmed} index row(s) trimmed after a retention sweep` : ""}`,
        },
      ]);
    } catch (err) {
      console.error("[recording/erasure-ack] audit append failed:", err);
    }
  }

  return NextResponse.json({ ok: true, confirmed, trimmed });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
