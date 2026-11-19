import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { workspaceView } from "@/lib/mobile/views";
import { closeRefusalFor, softDeleteCurrentTenant, SUPPORT_ADDRESS } from "@/lib/workspace/close";
import { restorableUntil } from "@/lib/workspace/close-gate";
import { PURGE_AFTER_DAYS } from "@/lib/platform/tenants";
import { getAdminEmails, sendMail } from "@/lib/email/mailer";
import { workspaceClosedEmail } from "@/lib/email/templates";
import { SUPPORT_USER_EMAIL } from "@/lib/support/session";
import { currentTenantId } from "@/lib/tenant/context";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";
import { withTenant, SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS = { not_available: 404, forbidden: 403, support_session: 403, reauth_required: 401, confirm_mismatch: 400 } as const;

// An admin closing their own workspace: the same soft delete the platform's
// Danger zone does, so it stays restorable by support for PURGE_AFTER_DAYS.
// Slow budget: the notice goes out by mail before the response.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ws = await workspaceView().catch(() => ({ name: "", slug: null as string | null }));
  const body = (await req.json().catch(() => ({}))) as { confirmSlug?: unknown };
  const refusal = await closeRefusalFor(user, ws.slug, body.confirmSlug ?? "");
  if (refusal) return NextResponse.json({ error: refusal }, { status: STATUS[refusal] });

  const slug = ws.slug as string;
  const tenantId = currentTenantId();
  const closedAt = new Date();
  const until = restorableUntil(closedAt, PURGE_AFTER_DAYS);
  const ip = clientIp(req.headers) ?? null;
  const summary = `Closed workspace ${slug}; restorable until ${until.toISOString().slice(0, 10)}`;

  // Both chains before anything is gone: the platform's, where operators look
  // when a customer asks for it back, and the workspace's own. Platform first,
  // in its own transaction, so it is on record even if the request fails later.
  await withTenant(PLATFORM_TENANT_ID, () =>
    recordAdminAction({
      actor: { id: user.id, email: user.email },
      action: "platform.tenant.self_close",
      targetType: "tenant",
      targetId: tenantId,
      summary: `Tenant ${slug} closed by its admin ${user.email} (purge in ${PURGE_AFTER_DAYS} days)`,
      metadata: { tenantId, tenantSlug: slug },
      clientIp: ip,
    }),
  ).catch(() => {});
  await recordAdminAction({ actor: { id: user.id, email: user.email }, action: "workspace.close", targetType: "tenant", targetId: tenantId, summary, clientIp: ip });

  const recipients = (await getAdminEmails()).filter((e) => e !== SUPPORT_USER_EMAIL);
  await softDeleteCurrentTenant();

  // Best-effort and after the close itself: a mail that fails must not keep the
  // workspace open, and one sent for a close that then failed would mislead.
  if (recipients.length) {
    const fmt = until.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    await sendMail({ to: recipients, ...workspaceClosedEmail({ workspace: ws.name || slug, closedBy: user.email, restorableUntil: fmt, support: SUPPORT_ADDRESS }) });
  }
  return NextResponse.json({ ok: true, restorableUntil: until.toISOString() });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
