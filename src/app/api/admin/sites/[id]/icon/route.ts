import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { parseLogoUpload } from "@/lib/site/logo";
import { appearanceFrom } from "@/lib/site/validate";
import { ICON_NAMES } from "@/lib/site/icons";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

// The resource's tile only (the "Change icon" dialog): a library icon and
// colour, or a logo and its background. Nothing about access changes here.
export const PUT = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const site = await db.site.findUnique({ where: { id }, select: { name: true } });
  if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const look = appearanceFrom(body, ICON_NAMES);
  if ("error" in look) return NextResponse.json({ error: look.error }, { status: 400 });
  const logo = parseLogoUpload(body.logo, body.logoType);
  if (logo.action === "error") return NextResponse.json({ error: logo.error }, { status: 400 });
  await db.site.update({
    where: { id },
    data: {
      ...look,
      ...(logo.action === "set" ? { logo: logo.data, logoType: logo.type } : logo.action === "clear" ? { logo: null, logoType: null } : {}),
    },
  });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.update",
    targetType: "resource", targetId: id,
    summary: `Changed the icon of "${site.name}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
