import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
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

// A recorded SSH session reached the resource's server for the first time:
// keep the host key it showed, so a different one is refused from now on
// (connector/sshproxy.go). Only fills an empty pin; one already kept (by an
// earlier session or a password rotation) is never replaced from here.
async function handler(req: NextRequest) {
  if (!dpAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const siteId = typeof b.siteId === "string" ? b.siteId : "";
  const fp = typeof b.fingerprint === "string" ? b.fingerprint.trim() : "";
  if (!siteId || !/^SHA256:[A-Za-z0-9+/]{20,64}=*$/.test(fp)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const res = await db.vaultCredential.updateMany({ where: { siteId, sshHostKey: null }, data: { sshHostKey: fp } });
  return NextResponse.json({ ok: true, kept: res.count > 0 });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
