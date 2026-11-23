import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { currentTenantId } from "@/lib/tenant/context";
import { managerBaseUrlFromHeaders } from "@/lib/url";
import { mintRdpTicket } from "@/lib/gateway/rdp-ticket";
import { nativeRdpTarget } from "@/lib/gateway/native-rdp-target";
import { rdpFile, rdpFileName } from "@/lib/gateway/native-rdp";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A .rdp file for the signed-in user's own Remote Desktop client: the
// resource's server behind this host's RD Gateway, with a ticket that can
// start a session for the next two minutes. Each click makes a new one. On a
// recorded resource Captivo signs in, so the file asks for no credentials.
export const GET = withTenantRoute(async (req: Request, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const secret = process.env.DATAPLANE_SECRET;
  if (!secret) return NextResponse.json({ error: "gateway_not_configured" }, { status: 503 });
  const { siteId } = await ctx.params;
  const now = new Date();
  const t = await nativeRdpTarget(user.id, siteId, now);
  if (!t.ok) return NextResponse.json({ error: t.error }, { status: t.status === 409 ? 409 : 404 });

  const gatewayHost = new URL(managerBaseUrlFromHeaders(req.headers, { fallbackOrigin: new URL(req.url).origin })).host;
  const ticket = mintRdpTicket({ tenantId: currentTenantId(), siteId, userId: user.id }, { secret, now });
  const body = rdpFile({ gatewayHost, targetHost: t.targetHost, targetPort: t.targetPort, token: ticket.token, redirection: t.redirection, recorded: t.mode === "recorded" });
  return new NextResponse(body, {
    headers: {
      "content-type": "application/x-rdp; charset=utf-8",
      "content-disposition": `attachment; filename="${rdpFileName(t.siteName)}"`,
      "cache-control": "no-store",
    },
  });
});
