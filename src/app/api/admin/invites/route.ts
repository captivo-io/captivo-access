import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can, ASSIGNABLE_ROLES } from "@/lib/auth/roles";
import { createInvite } from "@/lib/auth/invite";
import { normalizeEmail } from "@/lib/auth/email";
import { db } from "@/lib/db";
import { managerBaseUrl } from "@/lib/url";
import { getSmtpConfig, sendMail } from "@/lib/email/mailer";
import { inviteEmail } from "@/lib/email/templates";
import type { Role } from "@/generated/prisma/enums";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { assertWithinLimit, LimitError } from "@/lib/tenant/envelope";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const role = typeof body.role === "string" ? (body.role as Role) : undefined;
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const sendEmail = body.sendEmail === true;

  if (!name || !email || !role || !ASSIGNABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: "name_email_role_required" }, { status: 400 });
  }

  // Don't create a dead invite for an email that already has an account
  // (redemption would fail with email_taken). Case-insensitive to catch any
  // pre-existing mixed-case rows.
  const existing = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: "email_registered" }, { status: 409 });
  }

  try {
    await assertWithinLimit("maxUsers", await db.user.count());
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: "limit_reached", limit: e.key, max: e.max }, { status: 409 });
    throw e;
  }

  const { token } = await createInvite({
    email,
    name,
    role,
    createdById: admin.id,
    phone: phone || null,
    company: company || null,
  });
  const link = `${managerBaseUrl(req)}/invite/${token}`;

  let emailed = false;
  if (sendEmail) {
    try {
      const smtp = await getSmtpConfig();
      if (smtp?.enabled) {
        const m = inviteEmail({ name, link });
        const r = await sendMail({ to: email, subject: m.subject, html: m.html, text: m.text });
        emailed = r.sent;
      }
    } catch {
      // best-effort: email must never fail invite creation
    }
  }

  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "invite.create",
    targetType: "invite",
    summary: `Created invite for ${email}`,
    metadata: { email, role },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ link, emailed: sendEmail ? emailed : null });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
