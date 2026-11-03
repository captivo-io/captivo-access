import { endMobileSession, mobileSessionFromRequest } from "@/lib/mobile/session";
import { mobileJson } from "@/lib/mobile/route";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

/** Ends this app sign-in; its push registrations go with it (cascade). */
export const POST = withTenantRoute(async (req: Request) => {
  const s = await mobileSessionFromRequest(req);
  if (s) await endMobileSession(s.sessionId);
  return mobileJson({ ok: true });
});
