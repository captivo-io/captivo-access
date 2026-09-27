import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { decideGrant } from "@/lib/access/grants";
import { normalizeDenyReason } from "@/lib/access/deny-reason";
import { db } from "@/lib/db";
import { sendMail } from "@/lib/email/mailer";
import { accessDecisionEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const POST = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "approve_grants")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  const reason = normalizeDenyReason(body.reason);
  const count = await decideGrant(id, decision, admin.id, reason);
  if (count === 0) return NextResponse.json({ error: "not_pending" }, { status: 409 });

  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: decision === "approve" ? "grant.approve" : "grant.deny",
    targetType: "grant", targetId: id,
    summary: `${decision === "approve" ? "Approved" : "Denied"} access request ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });

  if (await notifyEmailEnabled("access_decisions")) {
    try {
      const grant = await db.accessGrant.findUnique({
        where: { id },
        select: { user: { select: { email: true } }, site: { select: { name: true } } },
      });
      if (grant?.user?.email) {
        const m = accessDecisionEmail({
          decision: decision === "approve" ? "approved" : "denied",
          siteName: grant.site.name,
          consoleUrl: await consoleBaseUrl(),
        });
        await sendMail({ to: grant.user.email, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best-effort: emailing the vendor must never change the decision outcome.
    }
  }

  return NextResponse.json({ ok: true });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
