import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { currentTenantId } from "@/lib/tenant/context";
import { nativeSshTarget } from "@/lib/gateway/native-ssh-target";
import { requireDataplaneSecret, resolveTenantBySite, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dpAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantBySite(typeof body.siteId === "string" ? body.siteId : "");
}

// The SSH jump host asks this when a user's own SSH client opens a channel
// with a ticket: is the grant still good, does the resource allow native
// clients, and where is its server. No credential leaves here.
async function handler(req: NextRequest) {
  if (!dpAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof b.userId === "string" ? b.userId : "";
  const siteId = typeof b.siteId === "string" ? b.siteId : "";
  if (!userId || !siteId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const t = await nativeSshTarget(userId, siteId, new Date());
  if (!t.ok) return NextResponse.json({ error: t.error, reason: t.reason }, { status: t.status });
  return NextResponse.json({
    tenantId: currentTenantId(),
    siteName: t.siteName,
    connectorId: t.connectorId,
    connectors: t.connectors,
    targetHost: t.targetHost,
    targetPort: t.targetPort,
  });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
