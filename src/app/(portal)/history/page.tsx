import { requireUser } from "@/lib/current-user";
import { historyPage, HISTORY_PAGE_SIZE } from "@/lib/portal/history";
import { withRequestTenant } from "@/lib/tenant/request";
import { HistoryList } from "./history-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "History" };

// Wrapped so its DB work runs under the request's tenant scope in cloud
// (pass-through on self-host). First proof site for withRequestTenant (RSC).
export default async function HistoryPage() {
  return withRequestTenant(async () => {
    const user = await requireUser();
    const initial = await historyPage(user.id, 0);
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>Session history</h1>
            <p>Your past remote sessions.</p>
          </div>
        </div>
        <HistoryList initial={initial} pageSize={HISTORY_PAGE_SIZE} />
      </div>
    );
  });
}
