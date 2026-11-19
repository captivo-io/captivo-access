import { requireUser } from "@/lib/current-user";
import { historyWindow } from "@/lib/portal/history";
import { resolvedAuditRetentionDays } from "@/lib/settings/platform";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { HistoryView } from "./history-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "History" };

// Wrapped so its DB work runs under the request's tenant scope in cloud
// (pass-through on self-host). First proof site for withRequestTenant (RSC).
export default async function HistoryPage() {
  return withRequestTenant(async () => {
    const user = await requireUser();
    const now = new Date();
    const [week, retentionDays, ws] = await Promise.all([
      historyWindow(user.id, now),
      resolvedAuditRetentionDays(),
      workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    ]);
    return (
      <main>
        <HistoryView initial={week} retentionDays={retentionDays} workspace={ws.slug} serverNow={now.getTime()} />
      </main>
    );
  });
}
