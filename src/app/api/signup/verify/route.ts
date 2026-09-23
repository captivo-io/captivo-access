import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { managerBaseUrl } from "@/lib/url";
import { signupEnabled, completeSignup } from "@/lib/signup/flow";

export const dynamic = "force-dynamic";

// The emailed confirmation link: creates the trial tenant and lands on its invite.
export const GET = withTenantRoute(async (req: NextRequest) => {
  if (currentTenantId() !== PLATFORM_TENANT_ID || !(await signupEnabled())) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const base = managerBaseUrl(req);
  // The person clicking the confirmation link -- a real browser request, so
  // this is their address and not a product server's. Read through clientIp,
  // never the first X-Forwarded-For hop (lib/request-ip.ts).
  const r = await completeSignup(req.nextUrl.searchParams.get("t") ?? "", clientIp(req.headers));
  if (!r.ok) return NextResponse.redirect(new URL(`/signup?error=${encodeURIComponent(r.error)}`, base));
  return NextResponse.redirect(r.inviteUrl);
});
