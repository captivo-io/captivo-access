import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import { cookieDomain, cookieSecure } from "@/lib/auth/cookies";
import { destroySession, getSessionUser, SESSION_COOKIE } from "@/lib/auth/session";
import { sha256 } from "@/lib/auth/tokens";
import { appRedirect, HANDOFF_COOKIE, HANDOFF_PATH, readHandoff } from "@/lib/mobile/handoff";
import { issueMobileCode } from "@/lib/mobile/session";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

/**
 * Where the console's Captivo ID sign-in lands for the app. Every refusal is
 * still a redirect to the app -- an error page in a sheet the app is waiting
 * on would leave the person nowhere to go.
 */
export const GET = withTenantRoute(async (req: NextRequest) => {
  const jar = await cookies();
  const challenge = readHandoff(jar.get(HANDOFF_COOKIE)?.value);
  jar.set(HANDOFF_COOKIE, "", { path: HANDOFF_PATH, maxAge: 0, httpOnly: true, sameSite: "lax", secure: await cookieSecure() });
  if (!challenge) return NextResponse.redirect(appRedirect({ error: "expired" }));

  const token = jar.get(SESSION_COOKIE)?.value ?? "";
  const user = token ? await getSessionUser(token) : null;
  if (!user) return NextResponse.redirect(appRedirect({ error: "signin" }));

  // The browser session only carried this sign-in to here; it is not left
  // behind in the phone's browser.
  const web = await db.session.findFirst({ where: { tokenHash: sha256(token) }, select: { amr: true } });
  await destroySession(token);
  jar.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: await cookieSecure(), domain: cookieDomain() });

  // Vendors use their own portal in the browser; the app is for the people who
  // run the workspace.
  if (!can(user.role, "read_console")) return NextResponse.redirect(appRedirect({ error: "not_admin" }));

  const code = await issueMobileCode(user.id, challenge, {
    amr: web?.amr ?? [],
    userAgent: "Captivo Admin app",
    ip: clientIp(req.headers) ?? null,
  });
  return NextResponse.redirect(appRedirect({ code }));
});
