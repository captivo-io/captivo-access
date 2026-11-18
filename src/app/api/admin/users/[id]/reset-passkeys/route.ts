import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { resetPasskeys, resetRefusal } from "@/lib/auth/passkey-reset";
import { managerBaseUrl } from "@/lib/url";
import { getSendingSmtpConfig, sendMail } from "@/lib/email/mailer";
import { passkeyResetEmail } from "@/lib/email/templates";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

// Removes every passkey (and console session) of a person and returns a
// one-time link to register a new one, shown once to the admin and emailed to
// the person when a mail server is available.
export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sendEmail = body.sendEmail !== false;

  const user = await db.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, status: true, centerRole: true, role: true } });
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const refusal = resetRefusal(admin.id, user);
  if (refusal) return NextResponse.json({ error: refusal }, { status: refusal === "not_found" ? 404 : 409 });

  const { id: resetId, token, removed } = await resetPasskeys(user.id, admin.id);
  const link = `${managerBaseUrl(req)}/reset/${token}`;

  let emailed: boolean | null = null;
  if (sendEmail) {
    emailed = false;
    try {
      const smtp = await getSendingSmtpConfig();
      if (smtp?.enabled) {
        const m = passkeyResetEmail({ name: user.name || user.email, link });
        emailed = (await sendMail({ to: user.email, subject: m.subject, html: m.html, text: m.text })).sent;
      }
    } catch {
      // best-effort: the admin still has the link
    }
  }

  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "user.passkeys_reset",
    targetType: "user", targetId: user.id,
    summary: `Reset the passkeys of ${user.email}`,
    metadata: { email: user.email, removed, resetId, emailed },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ link, emailed, removed });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
