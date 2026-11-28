import { NextRequest, NextResponse } from "next/server";
import { replicaWorkFor } from "@/lib/recording/replicas";
import { currentTenantId } from "@/lib/tenant/context";
import { requireDataplaneSecret, resolveTenantByConnector, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantByConnector(typeof body.connectorId === "string" ? body.connectorId : "");
}

// The data plane asks what a connector still owes a copy of (connector groups
// with recording replication on). Answers with the recordings and which member
// holds the original; the data plane does the copying.
async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  if (!connectorId) return NextResponse.json({ items: [] });
  return NextResponse.json({ items: await replicaWorkFor(connectorId, currentTenantId()) });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
