import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can, ASSIGNABLE_ROLES } from "@/lib/auth/roles";
import { createInvite } from "@/lib/auth/invite";
import { normalizeEmail } from "@/lib/auth/email";
import { db } from "@/lib/db";
import { managerBaseUrl } from "@/lib/url";
import { getSendingSmtpConfig, sendMail } from "@/lib/email/mailer";
import { inviteEmail } from "@/lib/email/templates";
import type { Role } from "@/generated/prisma/enums";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { assertWithinLimit, LimitError } from "@/lib/tenant/envelope";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

const MAX_TTL_HOURS = 30 * 24;

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
  // Link lifetime picked in the dialog (hours); the policy's default when absent.
  const ttl = body.expiresInHours;
  if (ttl !== undefined && !(typeof ttl === "number" && Number.isInteger(ttl) && ttl >= 1 && ttl <= MAX_TTL_HOURS)) {
    return NextResponse.json({ error: "invalid_expiry" }, { status: 400 });
  }

  if (!name || !email || !role || !ASSIGNABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: "name_email_role_required" }, { status: 400 });
  }

  // A workspace that belongs to a Captivo organisation gets its members from
  // the centre (lib/auth/center-role.ts): the console invites vendors only.
  if (role !== "VENDOR") {
    const tenant = await db.tenant.findUnique({ where: { id: currentTenantId() }, select: { captivoOrgId: true } });
    if (tenant?.captivoOrgId) {
      return NextResponse.json({ error: "members_come_from_center" }, { status: 409 });
    }
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

  const { id, token } = await createInvite({
    email,
    name,
    role,
    createdById: admin.id,
    phone: phone || null,
    company: company || null,
    ttlHours: typeof ttl === "number" ? ttl : undefined,
  });
  const link = `${managerBaseUrl(req)}/invite/${token}`;

  let emailed = false;
  if (sendEmail) {
    try {
      // The mail server that actually sends: the workspace's own, or on Cloud
      // the platform's when the operator allows that fallback.
      const smtp = await getSendingSmtpConfig();
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
    targetType: "invite", targetId: id,
    summary: `Created invite for ${email}`,
    metadata: { email, role },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ id, link, emailed: sendEmail ? emailed : null });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
