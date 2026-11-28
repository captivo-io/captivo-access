import { NextRequest, NextResponse } from "next/server";
import { applyReplicaReports, parseReplicaReports } from "@/lib/recording/replicas";
import { currentTenantId } from "@/lib/tenant/context";
import { requireDataplaneSecret, resolveTenantByConnector, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantByConnector(typeof body.connectorId === "string" ? body.connectorId : "");
}

// The data plane says where a connector's copies stand: how far along, whether
// the original is finished and the copy whole, or why the last pass stopped.
async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  if (!connectorId) return NextResponse.json({ ok: true, updated: 0 });
  const updated = await applyReplicaReports(connectorId, currentTenantId(), parseReplicaReports(body.items));
  return NextResponse.json({ ok: true, updated });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
