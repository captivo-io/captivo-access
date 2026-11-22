import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { recordCronRun } from "@/lib/cron/heartbeat";
import { forEachTenantId, inTenant } from "@/lib/cron/for-each-tenant";
import { runReviewPass } from "@/lib/review/store";
import { sendMail } from "@/lib/email/mailer";
import { accessReviewEmail } from "@/lib/email/templates";
import { pushToCapability } from "@/lib/mobile/push";
import { SLOW_SCOPE_BUDGET_MS, withTenant } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("authorization"), `Bearer ${s}`);
}

// Hourly: opens scheduled access reviews, closes the ones past due (applying
// their decisions), and reminds reviewers a week and a day before. Mail and
// push go out after each tenant's scope closes.
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await forEachTenantId(async (tenantId) => {
    const pass = await (tenantId === null
      ? (async () => { await recordCronRun("access-reviews"); return runReviewPass(); })()
      : withTenant(tenantId, async () => { await recordCronRun("access-reviews"); return runReviewPass(); }, { budgetMs: SLOW_SCOPE_BUDGET_MS }));
    for (const m of pass.mail) {
      const dueText = m.due.toUTCString().replace(/:\d\d GMT$/, " UTC");
      const e = accessReviewEmail({ kind: m.kind, name: m.name, dueText, pending: m.pending, url: m.url });
      if (m.to.length) await sendMail({ to: m.to, subject: e.subject, html: e.html, text: e.text }).catch(() => undefined);
      await inTenant(tenantId, () => pushToCapability("approve_grants", { title: e.subject, body: `${m.pending} grant${m.pending === 1 ? "" : "s"} to review`, data: { type: "access_review", url: m.url } })).catch(() => undefined);
    }
    return { opened: pass.opened, closed: pass.closed, mailed: pass.mail.length };
  });
  return NextResponse.json(results.length === 1 ? results[0] : { results });
}
