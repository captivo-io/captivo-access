import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { recordCronRun } from "@/lib/cron/heartbeat";
import { forEachTenantId, inTenant } from "@/lib/cron/for-each-tenant";
import { runTicketPass } from "@/lib/ticketing/recheck";
import { deliverTicketNotes } from "@/lib/ticketing/notes";
import { sendMail } from "@/lib/email/mailer";
import { accessDecisionEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { consoleBaseUrl } from "@/lib/tenant/console-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("authorization"), `Bearer ${s}`);
}

// Every 5 minutes: asks the ticket system about the tickets behind live grants
// (src/lib/ticketing/recheck.ts) and sends the work notes still waiting. The
// lookups run outside the tenant scopes; only the reads and writes are inside.
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await forEachTenantId(async (tenantId) => {
    await inTenant(tenantId, () => recordCronRun("tickets"));
    const pass = await runTicketPass(tenantId).catch((e) => { console.error("tickets: pass failed", e); return null; });
    const notes = await deliverTicketNotes(tenantId).catch((e) => { console.error("tickets: notes failed", e); return { sent: 0, failed: 0 }; });
    if (pass?.approvedMail.length) {
      const mail = await inTenant(tenantId, async () => ({ on: await notifyEmailEnabled("access_decisions"), base: await consoleBaseUrl().catch(() => "") }));
      for (const m of mail.on ? pass.approvedMail : []) {
        const e = accessDecisionEmail({ decision: "approved", siteName: m.site, consoleUrl: mail.base });
        await sendMail({ to: m.to, subject: e.subject, html: e.html, text: e.text }).catch(() => undefined);
      }
    }
    return {
      checked: pass?.checked ?? 0, ended: pass?.ended ?? 0, approved: pass?.approved ?? 0, shortened: pass?.shortened ?? 0, failed: pass?.failed ?? 0,
      notesSent: notes.sent, notesFailed: notes.failed,
    };
  });
  return NextResponse.json(results.length === 1 ? results[0] : { results });
}
