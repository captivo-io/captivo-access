import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { crossTenantHostnameTaken } from "@/lib/site/hostname";
import { withTenantRoute } from "@/lib/tenant/request";

// Whether a public address is free, while the admin types it. `label` is the
// part before the managed suffix; `host` a full custom domain. `except` is the
// resource being edited (its own address is not "taken").
export const GET = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const label = (sp.get("label") ?? "").trim().toLowerCase();
  const custom = (sp.get("host") ?? "").trim().toLowerCase();
  const except = sp.get("except");
  let host: string;
  if (custom) host = custom;
  else {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return NextResponse.json({ available: false, error: "invalid_hostname" });
    host = `${label}${(await siteHostSuffix()) ?? ""}`;
  }
  const mine = await db.site.findFirst({ where: { hostname: host, ...(except ? { NOT: { id: except } } : {}) }, select: { id: true } });
  const taken = !!mine || (await crossTenantHostnameTaken(host));
  return NextResponse.json({ available: !taken, host });
});
