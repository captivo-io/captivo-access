import { db } from "@/lib/db";

export type ActivityTone = "ok" | "deny" | "info" | "muted";
/** What the console's audit stream filters by. */
export type ActivityCategory = "session" | "recording" | "policy";

// One line in the console's activity stream. `kind` is the event-type slug shown as
// the badge (e.g. "access.allow", "grant.approve", "rec.saved"); `text` is the
// human description.
export interface ActivityItem {
  id: string;
  at: Date;
  kind: string;
  text: string;
  tone: ActivityTone;
  category: ActivityCategory;
}

// Pure: merge several event streams into one reverse-chronological feed, capped at
// `limit`. Kept separate so the ordering is unit-testable without a database.
export function mergeActivity(sources: ActivityItem[][], limit: number): ActivityItem[] {
  return sources
    .flat()
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit);
}

// A unified activity feed: access allow/deny (AuditEvent) + admin actions like grant
// approve/revoke (AdminAuditEvent) + saved session recordings, newest first. Each
// source is capped at `limit` before merging so one busy stream can't crowd out the
// others' recency.
export async function getActivityFeed(limit = 8): Promise<ActivityItem[]> {
  const [access, admin, recs] = await Promise.all([
    db.auditEvent.findMany({
      // Collapse the per-request web-app noise out of the feed: an ALLOW with no
      // reason is one proxied HTTP request (Proxmox polls many per second). These
      // stay in the audit log for compliance, but the feed shows the one
      // session_open ("connected") the proxy now emits per web session instead.
      // A recording replay's asset loads are the same kind of noise.
      where: { NOT: { AND: [{ decision: "ALLOW" }, { OR: [{ reason: null }, { reason: "" }, { reason: "replay" }] }] } },
      orderBy: { timestamp: "desc" }, take: limit,
      select: { id: true, timestamp: true, decision: true, userEmail: true, siteName: true, host: true, reason: true },
    }),
    db.adminAuditEvent.findMany({
      orderBy: { timestamp: "desc" }, take: limit,
      select: { id: true, timestamp: true, actorEmail: true, action: true, summary: true },
    }),
    db.sessionRecording.findMany({
      orderBy: { lastEventAt: "desc" }, take: limit,
      select: { id: true, lastEventAt: true, host: true },
    }),
  ]);

  const accessItems: ActivityItem[] = access.map((e) => {
    const reason = e.reason ?? "";
    const who = e.userEmail ?? "someone";
    const where = e.siteName ?? e.host;
    if (reason.startsWith("session_open")) {
      return { id: `a:${e.id}`, at: e.timestamp, kind: "session.connect", text: `${who} connected to ${where}`, tone: "ok", category: "session" };
    }
    if (reason.startsWith("session_close")) {
      const dur = reason.slice("session_close".length).trim();
      return { id: `a:${e.id}`, at: e.timestamp, kind: "session.disconnect", text: `${who} disconnected from ${where}${dur ? ` · ${dur}` : ""}`, tone: "muted", category: "session" };
    }
    return {
      id: `a:${e.id}`,
      at: e.timestamp,
      kind: e.decision === "ALLOW" ? "access.allow" : "access.deny",
      text: `${who} ${e.decision === "ALLOW" ? "accessed" : "blocked at"} ${where}`,
      tone: e.decision === "ALLOW" ? "ok" : "deny",
      // A refusal is the policy at work; an allowed request is part of a session.
      category: e.decision === "ALLOW" ? "session" : "policy",
    };
  });

  const adminItems: ActivityItem[] = admin.map((e) => ({
    id: `m:${e.id}`,
    at: e.timestamp,
    kind: e.action,
    text: e.actorEmail ? `${e.actorEmail} · ${e.summary}` : e.summary,
    tone: /revoke|deny|delete|disable/.test(e.action) ? "deny" : "info",
    category: e.action.startsWith("recording.") ? "recording" : "policy",
  }));

  const recItems: ActivityItem[] = recs.map((r) => ({
    id: `r:${r.id}`,
    at: r.lastEventAt,
    kind: "rec.saved",
    text: `session recording · ${r.host}`,
    tone: "muted",
    category: "recording",
  }));

  return mergeActivity([accessItems, adminItems, recItems], limit);
}
