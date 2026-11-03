import { db } from "@/lib/db";
import { redeemMobileCode } from "@/lib/mobile/session";
import { mobileJson } from "@/lib/mobile/route";
import { workspaceView, userView } from "@/lib/mobile/views";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

/** POST { code, verifier, device? } → the app's bearer token for this workspace. */
export const POST = withTenantRoute(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const device = typeof body.device === "string" ? `Captivo Admin app · ${body.device}` : null;
  const redeemed = await redeemMobileCode(body.code, body.verifier, device);
  if (!redeemed) return mobileJson({ error: "invalid_code" }, 400);
  const user = await db.user.findUnique({ where: { id: redeemed.userId } });
  if (!user || user.status !== "ACTIVE") return mobileJson({ error: "invalid_code" }, 400);
  return mobileJson({ token: redeemed.token, user: userView(user), workspace: await workspaceView() });
});
