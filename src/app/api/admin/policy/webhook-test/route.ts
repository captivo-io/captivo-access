import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { publicUrlProblem } from "@/lib/net/public-url";
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
  if (multiTenantEnabled()) {
    const problem = await publicUrlProblem(url);
    if (problem) return NextResponse.json({ error: problem === "private_address" ? "private_address" : "unresolvable" }, { status: 400 });
  }

  let status: number | null = null;
  let reason: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Test from Captivo Access: notifications reach this webhook.", event: "test", site: "Example resource", at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });
    status = res.status;
  } catch (e) {
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
