import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { appendAuditEvents } from "@/lib/audit/append";
import { clientIp } from "@/lib/request-ip";
import { findOwnWebSession } from "@/lib/dataplane/client";
import { withRequestTenant } from "@/lib/tenant/request";
import { WebLiveViewer } from "./web-live-viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live session" };

/**
 * Live view of a web app tab: the page as the vendor sees it, rebuilt from the
 * recorder's events as they arrive. Read-only by nature -- the session runs in
 * the vendor's own browser. Only a tab of this tenant's own sites is offered;
 * the data-plane checks the viewer again when the stream opens.
 */
async function WebLivePageImpl({ params }: { params: Promise<{ key: string }> }) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "read_console")) notFound();
  const { key } = await params;
  const liveKey = decodeURIComponent(key);
  const session = await findOwnWebSession(liveKey);
  if (!session) notFound();

  const h = await headers();
  try {
    await appendAuditEvents([
      {
        userId: user.id,
        host: "manager",
        method: "GET",
        path: `/live/web/${liveKey}`,
        status: 200,
        decision: "ALLOW",
        reason: "Admin opened a live web app view",
        clientIp: clientIp(h),
        userAgent: h.get("user-agent") ?? undefined,
      },
    ]);
  } catch {
    /* best-effort */
  }
  return <WebLiveViewer liveKey={liveKey} label={session.host} />;
}

export default async function WebLivePage(...args: Parameters<typeof WebLivePageImpl>) {
  return withRequestTenant(() => WebLivePageImpl(...args));
}
