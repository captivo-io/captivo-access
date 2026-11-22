import Link from "next/link";
import { requireCapability } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { RECURRENCE_LABEL, type Recurrence, type ReviewSummary } from "@/lib/review/plan";
import { NewReviewButton } from "./new-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Access reviews" };

const STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "Open", tone: "warn" }, scheduled: { label: "Scheduled", tone: "neutral" },
  closed: { label: "Closed", tone: "ok" }, cancelled: { label: "Cancelled", tone: "neutral" },
};

async function ReviewsPageImpl() {
  const user = await requireCapability("read_console");
  const canReview = can(user.role, "approve_grants");
  const [ws, reviews, sites, liveGrants] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.accessReview.findMany({ orderBy: [{ createdAt: "desc" }], take: 100 }),
    db.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.accessGrant.count({ where: { status: "ACTIVE", OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] } }),
  ]);
  const open = reviews.filter((r) => r.status === "open").map((r) => r.id);
  const counts = open.length
    ? await db.accessReviewItem.groupBy({ by: ["reviewId"], where: { reviewId: { in: open } }, _count: { _all: true }, _min: { decidedAt: true } })
    : [];
  const decided = open.length
    ? await db.accessReviewItem.groupBy({ by: ["reviewId"], where: { reviewId: { in: open }, decision: { not: null } }, _count: { _all: true } })
    : [];
  const total = new Map(counts.map((c) => [c.reviewId, c._count._all]));
  const done = new Map(decided.map((c) => [c.reviewId, c._count._all]));
  const last = reviews.find((r) => r.status === "closed");

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Operate{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Access reviews</h1>
          <p>Confirm, every so often, that everyone who can reach a resource still should. Unused access stands out; what nobody confirms by the due date is removed, unless you choose otherwise.</p>
        </div>
        {canReview && <NewReviewButton sites={sites} />}
      </div>

      <div className="kstrip">
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot p" />Live grants</span><span className="kcell-row"><span className="kcell-v">{liveGrants}</span><span className="kcell-s">in scope of a new review</span></span></div>
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot warn" />Open reviews</span><span className="kcell-row"><span className="kcell-v">{open.length}</span><span className="kcell-s">{open.length ? `${[...total.values()].reduce((a, b) => a + b, 0) - [...done.values()].reduce((a, b) => a + b, 0)} grants to decide` : "nothing waiting"}</span></span></div>
        <div className="kcell"><span className="kcell-k"><span className="rs-kdot ok" />Last completed</span><span className="kcell-row"><span className="kcell-v rv-small">{last?.closedAt ? <LocalTime iso={last.closedAt.toISOString()} mode="date" /> : "Never"}</span><span className="kcell-s">{last ? last.name : "no review closed yet"}</span></span></div>
      </div>

      {reviews.length === 0 ? (
        <div className="au-empty arv-empty">
          <b>No access reviews yet</b>
          <span className="cell-sub">Start one to list every live grant with when it was last used. Auditors ask for this every quarter or year; a recurring review opens itself.</span>
          {canReview && <NewReviewButton sites={sites} primary />}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table arv-list">
            <thead><tr><th>Review</th><th>Status</th><th>Progress</th><th>Due</th><th>Repeats</th></tr></thead>
            <tbody>
              {reviews.map((r) => {
                const s = STATUS[r.status] ?? STATUS.closed;
                const sum = r.summary as ReviewSummary | null;
                const t = total.get(r.id) ?? 0, d = done.get(r.id) ?? 0;
                return (
                  <tr key={r.id}>
                    <td><Link href={`/admin/reviews/${r.id}`} className="arv-name">{r.name}</Link><div className="cell-sub">{r.siteIds.length ? `${r.siteIds.length} resource${r.siteIds.length === 1 ? "" : "s"}` : "All resources"}</div></td>
                    <td><span className={`pill ${s.tone}`}>{s.label}</span></td>
                    <td>
                      {r.status === "open" ? (
                        <span className="arv-prog"><span className="arv-bar"><span style={{ width: `${t ? Math.round((d / t) * 100) : 100}%` }} /></span><span className="mono cell-sub">{d}/{t}</span></span>
                      ) : r.status === "closed" && sum ? (
                        <span className="cell-sub">{sum.total} grants · {(sum.revoked ?? 0) + (sum.auto_revoked ?? 0)} revoked · {sum.kept ?? 0} kept{sum.unanswered ? ` · ${sum.unanswered} without a decision` : ""}{sum.ad_remove ? ` · ${sum.ad_remove} for the directory` : ""}</span>
                      ) : r.status === "scheduled" ? (
                        <span className="cell-sub">Opens <LocalTime iso={r.opensAt.toISOString()} mode="date" /></span>
                      ) : <span className="cell-sub">—</span>}
                    </td>
                    <td className="cell-sub">{r.dueAt ? <LocalTime iso={r.dueAt.toISOString()} /> : `${r.dueDays} days after it opens`}</td>
                    <td className="cell-sub">{r.recurrence ? RECURRENCE_LABEL[r.recurrence as Recurrence] : "Once"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export default async function ReviewsPage(...args: Parameters<typeof ReviewsPageImpl>) {
  return withRequestTenant(() => ReviewsPageImpl(...args));
}
