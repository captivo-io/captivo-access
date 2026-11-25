import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { issueRdpFile } from "@/lib/gateway/native-rdp-issue";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A .rdp file for the signed-in user's own Remote Desktop client
// (lib/gateway/native-rdp-issue.ts). Each click makes a new one.
export const GET = withTenantRoute(async (req: Request, ctx: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await ctx.params;
  const r = await issueRdpFile(user, siteId, req);
  if (r.status !== 200) return NextResponse.json({ error: r.error }, { status: r.status });
  return new NextResponse(r.body, {
    headers: {
      "content-type": "application/x-rdp; charset=utf-8",
      "content-disposition": `attachment; filename="${r.fileName}"`,
      "cache-control": "no-store",
    },
  });
});
