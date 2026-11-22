import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { currentTenantId } from "@/lib/tenant/context";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { workspaceView } from "@/lib/mobile/views";
import { CONFIG_ERROR, parseSystem, secretRequired } from "@/lib/ticketing/config";
import { describeSystemError, lookupTicket } from "@/lib/ticketing/providers";
import { KIND_LABEL, normalizeRef, refusalText, verdict } from "@/lib/ticketing/rules";

export const runtime = "nodejs";

/**
 * Looks one ticket up with the form's values, saved or not (a blank secret
 * borrows the stored one under the same rule as saving), and says what it
 * would mean for a person: `as` is their e-mail, else the admin's.
 */
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = parseSystem(body, { cloud: multiTenantEnabled() });
  if (!p.ok) return NextResponse.json({ ok: false, message: CONFIG_ERROR[p.error] ?? p.error });
  if (p.data.kind === "none") return NextResponse.json({ ok: false, message: "Numbers-only mode doesn't look tickets up." });
  const ref = normalizeRef(body.ref, p.data.kind);
  if (!ref) return NextResponse.json({ ok: false, message: p.data.kind === "jira" ? "Enter a Jira key such as OPS-123." : "Enter a ticket number to look up." });
  const existing = await db.ticketSystem.findUnique({ where: { tenantId: currentTenantId() }, select: { kind: true, baseUrl: true, secret: true } });
  let secret = p.secret;
  if (!secret && existing?.secret && existing.kind === p.data.kind && existing.baseUrl === p.data.baseUrl) {
    try {
      secret = decrypt(existing.secret);
    } catch {
      return NextResponse.json({ ok: false, message: "The saved password or token can't be read; enter it again." });
    }
  }
  if (!secret && secretRequired(p.data.kind)) return NextResponse.json({ ok: false, message: CONFIG_ERROR.secret_required });
  const as = typeof body.as === "string" && body.as.includes("@") ? body.as.trim() : admin.email;
  const ws = await workspaceView().catch(() => ({ slug: null as string | null }));
  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const f = await lookupTicket(p.data, secret, ref, { user: { email: as, name: null }, resource: null, workspace: ws.slug ?? "default" });
    const v = verdict(f, { kind: p.data.kind, allowedStates: p.data.allowedStates, matchAssignee: p.data.matchAssignee }, { email: as });
    const label = p.data.kind === "https" ? "The endpoint" : KIND_LABEL[p.data.kind];
    result = {
      ok: true,
      latencyMs: Date.now() - started,
      found: !!f,
      ticket: f ? { ref: f.ref, title: f.title, state: f.state, approved: f.approved, rejected: !!f.rejected, start: f.start?.toISOString() ?? null, end: f.end?.toISOString() ?? null, assignee: f.assignee, url: f.url } : null,
      verdict: v.ok ? { ok: true, approved: v.approved } : { ok: false, message: refusalText(v.why, v.detail, label) },
      as,
    };
  } catch (e) {
    result = { ok: false, message: describeSystemError(e) };
  }
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.ticketing_test",
    summary: `Looked up ticket ${ref} in ${KIND_LABEL[p.data.kind]}`,
    metadata: { ok: result.ok === true, found: result.found ?? null },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json(result);
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
