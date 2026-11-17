import { requireUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listUserRequests } from "@/lib/access/grants";
import { requestStatus, type RequestState } from "@/lib/portal/request-status";
import { remaining } from "@/lib/portal/time-remaining";
import { resolvedRequireRequestJustification } from "@/lib/settings/platform";
import { RequestAccessButton } from "../access/request-access-button";
import { WithdrawRequestButton } from "../access/withdraw-request-button";
import { SentToast } from "./sent-toast";
import { withRequestTenant } from "@/lib/tenant/request";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { Empty } from "@/app/(app)/_console/console-home";

export const dynamic = "force-dynamic";
export const metadata = { title: "My requests" };

const BADGE: Record<RequestState, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "warn" },
  approved: { label: "Approved", cls: "ok" },
  denied: { label: "Denied", cls: "danger" },
  withdrawn: { label: "Withdrawn", cls: "neutral" },
  expired: { label: "Expired", cls: "neutral" },
};

async function RequestsPageImpl({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const user = await requireUser();
  const sent = (await searchParams).sent === "1";
  const now = new Date();
  const rows = await listUserRequests(user.id);
  const deciderIds = [...new Set(rows.map((r) => r.approvedById).filter((x): x is string => !!x))];
  const deciders = deciderIds.length
    ? new Map((await db.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map<string, string>();
  const requireJustification = await resolvedRequireRequestJustification();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>My requests</h1>
          <p>Access you asked for, and what was decided.</p>
        </div>
        <RequestAccessButton requireJustification={requireJustification} />
      </div>
      {rows.length === 0 ? (
        <div className="card">
          <Empty icon="inbox" title="No requests yet" text="Ask for access to a resource and the request is listed here until it is decided." />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Resource</th><th>Access window</th><th>Requested</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = requestStatus(
                  { status: r.status, approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null, endsAt: r.endsAt ? r.endsAt.toISOString() : null },
                  now,
                );
                const b = BADGE[st];
                const reason = st === "denied" ? r.denyReason : r.note;
                const win = remaining(r.startsAt ? r.startsAt.toISOString() : null, r.endsAt ? r.endsAt.toISOString() : null, r.schedule, now);
                const decider = r.approvedById ? deciders.get(r.approvedById) : null;
                return (
                  <tr key={r.id}>
                    <td>
                      <div className="rqt-res">
                        <b>{r.site.name}</b>
                        {reason && <span className="cell-sub cell-truncate">{reason}</span>}
                      </div>
                    </td>
                    <td className="cell-sub">
                      {r.endsAt || r.startsAt
                        ? <>{r.startsAt ? <LocalTime iso={r.startsAt.toISOString()} mode="short" /> : "From approval"} → {r.endsAt ? <LocalTime iso={r.endsAt.toISOString()} mode="short" /> : "no end"}</>
                        : win.text}
                    </td>
                    <td className="cell-sub">
                      <LocalTime iso={r.createdAt.toISOString()} mode="shortdate" />
                      {decider && <> · {st === "denied" ? "denied" : "approved"} by {decider}</>}
                    </td>
                    <td><span className={`pill ${b.cls}`}>{b.label}</span></td>
                    <td style={{ textAlign: "right" }}>{st === "pending" && <WithdrawRequestButton id={r.id} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sent && <SentToast />}
    </>
  );
}

export default async function RequestsPage(...args: Parameters<typeof RequestsPageImpl>) {
  return withRequestTenant(() => RequestsPageImpl(...args));
}
