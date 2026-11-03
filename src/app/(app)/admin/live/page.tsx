import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { liveRows } from "@/lib/live/rows";
import { LiveTable } from "./live-table";
import { AutoRefresh } from "@/app/(app)/_shell/auto-refresh";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Live sessions" };

async function AdminLivePageImpl() {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "read_console")) notFound();

  const rows = await liveRows();

  return (
    <main>
      <AutoRefresh />
      <div className="page-head">
        <div>
          <h1>Live sessions</h1>
          <p>In-progress remote-desktop and web-app sessions.</p>
        </div>
      </div>
      <LiveTable rows={rows} canTerminate={can(user!.role, "configure")} />
    </main>
  );
}

export default async function AdminLivePage(...args: Parameters<typeof AdminLivePageImpl>) {
  return withRequestTenant(() => AdminLivePageImpl(...args));
}

