import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { createAccessRequest, listUserGrants } from "@/lib/access/grants";
import { classifyGrant } from "@/lib/access/evaluate";
import { validateSchedule, type Schedule } from "@/lib/access/schedule";
import { grantCapError } from "@/lib/access/grant-edit";
import { resolvedMaxGrantDays, resolvedRequireRequestJustification } from "@/lib/settings/platform";
import { sendMail, getAdminEmails } from "@/lib/email/mailer";
import { approvalRequestEmail } from "@/lib/email/templates";
import { notifyEmailEnabled } from "@/lib/notifications/gate";
import { withTenantRoute } from "@/lib/tenant/request";
import { consoleBaseUrl } from "@/lib/tenant/console-url";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

function parseDate(value: unknown): { ok: true; value: Date | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}

export const POST = withTenantRoute(async (req: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
  if (!siteId) return NextResponse.json({ error: "site_required" }, { status: 400 });

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note && (await resolvedRequireRequestJustification())) {
    return NextResponse.json({ error: "note_required" }, { status: 400 });
  }

  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (!startsAt.ok || !endsAt.ok) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  if (startsAt.value && endsAt.value && startsAt.value > endsAt.value) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const capErr = grantCapError(startsAt.value, endsAt.value, new Date(), await resolvedMaxGrantDays());
  if (capErr) return NextResponse.json({ error: capErr }, { status: 400 });

  let schedule: Schedule | null = null;
  if (body.schedule !== undefined && body.schedule !== null) {
    const v = validateSchedule(body.schedule);
    if (!v.ok) return NextResponse.json({ error: "invalid_schedule" }, { status: 400 });
    schedule = v.schedule;
  }

  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, name: true } });
  if (!site) return NextResponse.json({ error: "invalid_site" }, { status: 400 });

  // Guard against requesting a site the user already holds (active/upcoming/pending/
  // off-hours) — the picker hides these, but block a direct API call too.
  const held = (await listUserGrants(user.id)).some(
    (g) => g.site.id === siteId && !["revoked", "denied", "expired"].includes(classifyGrant(g, new Date())),
  );
  if (held) return NextResponse.json({ error: "already_have_access" }, { status: 409 });

  const result = await createAccessRequest({
    userId: user.id,
    siteId,
    startsAt: startsAt.value,
    endsAt: endsAt.value,
    note,
    schedule,
  });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });

  if (await notifyEmailEnabled("access_requests")) {
    try {
      const admins = await getAdminEmails();
      if (admins.length > 0) {
        const m = approvalRequestEmail({
          vendorName: user.name,
          vendorEmail: user.email,
          siteName: site.name,
          consoleUrl: await consoleBaseUrl(),
        });
        await sendMail({ to: admins, subject: m.subject, html: m.html, text: m.text });
      }
    } catch {
      // Best-effort: notifying admins must never fail the request.
    }
  }

  return NextResponse.json({ id: result.id }, { status: 201 });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
