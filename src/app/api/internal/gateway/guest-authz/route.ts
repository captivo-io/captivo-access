import { NextRequest, NextResponse } from "next/server";
import { guestAuthz } from "@/lib/live/invites";
import { parseGuestPass } from "@/lib/live/invite-token";
import { requireDataplaneSecret, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The data plane asks whether an invited guest's pass lets its holder watch one
// live session (dataplane/guestview.go). The pass names its workspace; the
// invite must be found there, match, and be for exactly this session and site.
async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return parseGuestPass(typeof body.token === "string" ? body.token : "")?.tenantId ?? null;
}

async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const siteId = typeof body.siteId === "string" ? body.siteId : "";
  if (!token || !sessionId || !siteId) return NextResponse.json({ allow: false });
  return NextResponse.json(await guestAuthz(token, sessionId, siteId));
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
