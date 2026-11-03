import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { cookieSecure } from "@/lib/auth/cookies";
import { HANDOFF_COOKIE, HANDOFF_PATH, HANDOFF_TTL_SEC, isPkceChallenge, signHandoff } from "@/lib/mobile/handoff";
import { managerBaseUrl } from "@/lib/url";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

/**
 * GET /api/mobile/auth/start?challenge=<S256>, on the workspace's own host.
 *
 * The app's "Connect" button opens this in the system browser. It remembers
 * the challenge and runs the console's own Captivo ID sign-in, which comes
 * back to /finish. See lib/mobile/handoff.ts for the whole flow.
 */
export const GET = withTenantRoute(async (req: NextRequest) => {
  const challenge = req.nextUrl.searchParams.get("challenge");
  if (!isPkceChallenge(challenge)) return new NextResponse("bad request", { status: 400 });

  // Lax, not Strict: it has to come along on the top-level redirect back from
  // the identity centre.
  (await cookies()).set(HANDOFF_COOKIE, signHandoff(challenge), {
    path: HANDOFF_PATH, maxAge: HANDOFF_TTL_SEC, httpOnly: true, sameSite: "lax", secure: await cookieSecure(),
  });
  const next = new URL("/api/auth/oidc/start", managerBaseUrl(req));
  next.searchParams.set("returnTo", `${HANDOFF_PATH}/finish`);
  return NextResponse.redirect(next);
});
