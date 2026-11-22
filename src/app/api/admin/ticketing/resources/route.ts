import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { MODE_LABEL, TICKET_MODES, type TicketMode } from "@/lib/ticketing/rules";

export const runtime = "nodejs";

/** Sets what resources ask for: `{ siteIds, mode }`, mode null = the workspace default. */
export const PUT = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const siteIds = Array.isArray(body.siteIds) ? [...new Set(body.siteIds.filter((v): v is string => typeof v === "string" && v !== ""))].slice(0, 500) : [];
  if (!siteIds.length) return NextResponse.json({ error: "sites_required" }, { status: 400 });
  const mode = body.mode === null ? null : (body.mode as TicketMode);
  if (mode !== null && !TICKET_MODES.includes(mode)) return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
  const sites = await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } });
  await db.site.updateMany({ where: { id: { in: sites.map((s) => s.id) } }, data: { ticketMode: mode } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.ticketing_resources",
    summary: `Set ${sites.length === 1 ? sites[0].name : `${sites.length} resources`} to ${mode ? MODE_LABEL[mode] : "the workspace default"} for tickets`,
    metadata: { siteIds: sites.map((s) => s.id), mode },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true, done: sites.length });
});
