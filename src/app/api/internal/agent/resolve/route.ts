import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { authenticateAgent } from "@/lib/agent/auth";
import { requireDataplaneSecret, resolveTenantBySite, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dataplaneAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantBySite(typeof body.siteId === "string" ? body.siteId : "");
}

// The web proxy asks this for a request that carries an agent token (header
// X-Captivo-Agent-Token): who the token is, if it is live and its resource is
// one it may use. The grant itself is checked by the proxy's access check, as
// for a person, on every request.
async function handler(req: NextRequest) {
  if (!dataplaneAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token : "";
  const siteId = typeof b.siteId === "string" ? b.siteId : "";
  const agent = token && siteId ? await authenticateAgent(`Bearer ${token}`) : null;
  if (!agent || !agent.token.siteIds.includes(siteId)) return NextResponse.json({ error: "no_agent" }, { status: 401 });
  const site = await db.site.findUnique({ where: { id: siteId }, select: { accessMode: true } });
  if (site?.accessMode !== "TRANSPARENT") return NextResponse.json({ error: "no_agent" }, { status: 401 });
  return NextResponse.json({ userId: agent.user.id, email: agent.user.email });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
