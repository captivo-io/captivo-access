import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { createInvite } from "@/lib/auth/invite";
import { managerBaseUrl } from "@/lib/url";
import { getSmtpConfig, sendMail } from "@/lib/email/mailer";
import { inviteEmail } from "@/lib/email/templates";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const old = await db.invite.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, phone: true, company: true, usedAt: true },
  });
  if (!old) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (old.usedAt) return NextResponse.json({ error: "already_used" }, { status: 409 });

  // Atomically consume the old pending invite BEFORE minting the replacement:
  // if it was enrolled between the read above and here, deleteMany matches 0
  // rows and we bail — never deleting the now-consumed record or minting a
  // dangling invite for an already-registered email.
  const consumed = await db.invite.deleteMany({ where: { id, usedAt: null } });
  if (consumed.count === 0) return NextResponse.json({ error: "already_used" }, { status: 409 });

  const { token } = await createInvite({
    email: old.email, name: old.name, role: old.role, createdById: admin.id, phone: old.phone, company: old.company,
  });

  const link = `${managerBaseUrl(req)}/invite/${token}`;

  let emailed = false;
  try {
    const smtp = await getSmtpConfig();
    if (smtp?.enabled) {
      const m = inviteEmail({ name: old.name, link });
      const r = await sendMail({ to: old.email, subject: m.subject, html: m.html, text: m.text });
      emailed = r.sent;
    }
  } catch {
    // best-effort: email must never fail the resend
  }
  return NextResponse.json({ link, emailed });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
