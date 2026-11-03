import { terminateLiveSession } from "@/lib/live/terminate";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { clientIp } from "@/lib/request-ip";

export const dynamic = "force-dynamic";

/** POST { grantId? } -- with the grant, the vendor cannot simply reconnect. */
export const POST = mobileRoute("configure", async (req, { user }, ctx: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { grantId?: unknown };
  const grantId = typeof body.grantId === "string" && body.grantId ? body.grantId : null;
  const result = await terminateLiveSession({
    actor: { id: user.id, email: user.email },
    sessionId,
    grantId,
    clientIp: clientIp(req.headers) ?? null,
    via: "app",
  });
  if (!result.found) return mobileJson({ error: "not_found" }, 404);
  return mobileJson(result);
});
