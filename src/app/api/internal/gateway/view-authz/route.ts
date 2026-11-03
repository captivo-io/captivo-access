import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import { requireDataplaneSecret, resolveTenantByUser, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dataplaneAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantByUser(typeof body.userId === "string" ? body.userId : "");
}

async function handler(req: NextRequest) {
  if (!dataplaneAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId : "";
  const siteId = typeof body.siteId === "string" ? body.siteId : "";
  // Both required: the data plane's registry holds every tenant's sessions, so
  // the role alone would let one workspace's admin watch another's. This runs in
  // the viewer's tenant scope, so a site from another tenant is simply not found.
  if (!userId || !siteId) return NextResponse.json({ allow: false });
  const [user, site] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { role: true } }),
    db.site.findUnique({ where: { id: siteId }, select: { id: true } }),
  ]);
  return NextResponse.json({ allow: !!user && !!site && can(user.role, "read_console") });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
