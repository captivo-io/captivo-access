import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { destinationFromBody } from "@/lib/logforward/api";
import { deliverTo, describeFailure, formatContext, storedSecret } from "@/lib/logforward/pump";
import { testRecord } from "@/lib/logforward/records";

export const runtime = "nodejs";

/**
 * Sends one test record with the form's values, saved or not (`id` lends the
 * stored secret when the field is blank). Answers how it went, in words.
 */
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const existing = typeof body.id === "string"
    ? await db.logDestination.findUnique({ where: { id: body.id }, select: { kind: true, secret: true } })
    : null;
  const r = await destinationFromBody(body, existing);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  const secret = storedSecret(r.data.secret ?? null);
  if (secret === undefined) return NextResponse.json({ ok: false, message: describeFailure("secret_unreadable") });

  const ctx = await formatContext();
  const result = await deliverTo(r.data, secret, [testRecord(admin.email)], ctx);
  const target = r.data.kind === "syslog" ? `${r.data.host}:${r.data.port}` : new URL(r.data.url!).host;
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.log_destination_test",
    summary: `Sent a test record to ${target}`,
    metadata: { kind: r.data.kind, ok: result.ok, reason: result.ok ? null : result.reason },
    clientIp: clientIp(req.headers) ?? null,
  });
  return result.ok
    ? NextResponse.json({ ok: true, latencyMs: result.latencyMs })
    : NextResponse.json({ ok: false, message: describeFailure(result.reason, result.detail) });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
