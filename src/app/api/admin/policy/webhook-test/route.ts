import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { tenantFetch, PrivateAddressError } from "@/lib/net/guarded-fetch";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";

// Sends one sample event to the webhook URL typed on the Policy page (saved or
// not) and reports the HTTP status, in the same shape real events use.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    return NextResponse.json({ error: "invalid_webhook_url" }, { status: 400 });
  }
  let status: number | null = null;
  let reason: string | null = null;
  try {
    // Guarded on Cloud: no private or internal addresses, no redirects.
    const res = await tenantFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Test from Captivo Access: notifications reach this webhook.", event: "test", site: "Example resource", at: new Date().toISOString() }),
      timeoutMs: 5000,
    });
    status = res.status;
  } catch (e) {
    if (e instanceof PrivateAddressError) return NextResponse.json({ error: "private_address" }, { status: 400 });
    reason = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "unreachable";
  }
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.webhook_test",
    summary: `Sent a test event to ${parsed.host}`,
    metadata: { host: parsed.host, status, reason },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: status !== null && status >= 200 && status < 300, status, reason });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
