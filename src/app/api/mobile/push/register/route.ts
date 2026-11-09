import { db } from "@/lib/db";
import { isExpoToken } from "@/lib/mobile/push";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { currentTenantId } from "@/lib/tenant/context";

export const dynamic = "force-dynamic";

/** POST { expoPushToken, platform? } -- this phone hears this workspace. */
export const POST = mobileRoute(["read_console", "manage_tenants"], async (req, { user, sessionId }) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isExpoToken(body.expoPushToken)) return mobileJson({ error: "invalid_token" }, 400);
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 20) : null;
  // A phone handed to someone else, or signed in again, takes the row over:
  // one token, one person, one sign-in.
  await db.mobileDevice.upsert({
    where: { tenantId_expoPushToken: { tenantId: currentTenantId(), expoPushToken: body.expoPushToken } },
    create: { userId: user.id, sessionId, expoPushToken: body.expoPushToken, platform },
    update: { userId: user.id, sessionId, platform },
  });
  return mobileJson({ ok: true });
});
