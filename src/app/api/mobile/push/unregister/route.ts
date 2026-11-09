import { db } from "@/lib/db";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";

export const dynamic = "force-dynamic";

export const POST = mobileRoute(["read_console", "manage_tenants"], async (req, { sessionId }) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.expoPushToken === "string") {
    await db.mobileDevice.deleteMany({ where: { sessionId, expoPushToken: body.expoPushToken } });
  }
  return mobileJson({ ok: true });
});
