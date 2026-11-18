import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/request-ip";
import { verifyPasskeyReset } from "@/lib/auth/passkey-reset";
import { setRecoverToken } from "@/lib/auth/recover-token";
import { checkRateLimit } from "@/lib/rate-limit";
import { withTenantRoute } from "@/lib/tenant/request";

// Step 1 of a reset link: a valid link earns the short-lived recovery cookie
// (bound to this reset), with which registration mode "recover" adds the new
// passkey. The link is consumed only when that passkey is saved.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const ip = clientIp(req.headers) ?? "unknown";
  if (!checkRateLimit(`${ip}:${new URL(req.url).pathname}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token : "";
  const reset = await verifyPasskeyReset(token);
  if (!reset || reset.user.status !== "ACTIVE") return NextResponse.json({ error: "reset_invalid" }, { status: 410 });
  await setRecoverToken(reset.user.id, reset.id);
  return NextResponse.json({ ok: true });
});
