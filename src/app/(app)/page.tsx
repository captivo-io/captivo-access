import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { can, isConsoleUser, ROLE_LABELS } from "@/lib/auth/roles";
import { getConsoleData } from "@/lib/console/data";
import { workspaceView } from "@/lib/mobile/views";
import { ConsoleHome } from "./_console/console-home";
import { Onboarding } from "./_console/onboarding";
import { getOnboardingFacts, onboardingView } from "@/lib/console/onboarding";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Console" };

async function DashboardPageImpl() {
  const user = await requireUser();
  if (!isConsoleUser(user.role)) {
    redirect("/access");
  }
  const ws = await workspaceView().catch(() => ({ name: "", slug: null as string | null, origin: "" }));
  const first = user.name.trim().split(/\s+/)[0] || user.name;
  const role = ROLE_LABELS[user.role] ?? user.role;

  const head = (actions: boolean, setup = false) => (
    <div className="page-head">
      <div>
        <div className="eyebrow">
          Console{ws.slug ? ` · ${ws.slug}` : ""} <span className="chip violet">{role}</span>
        </div>
        <h1>Hello, {first}</h1>
        {setup && <p className="ob-lead">Your Captivo Access account is live. In three steps your first user reaches an internal app from the browser, with no VPN.</p>}
      </div>
      {setup && <span className="ob-ready">Workspace ready</span>}
      {actions && (
        <div className="row-actions">
          <Link href="/admin/users?new=1" className="btn">Invite vendor</Link>
          {can(user.role, "approve_grants") && <Link href="/admin/grants?new=1" className="btn primary">+ Grant access</Link>}
        </div>
      )}
    </div>
  );

  if (user.role !== "ADMIN") {
    return (
      <main>
        {head(false)}
        <div className="card">
          <p>Use the menu to review access grants, live sessions and the audit log.</p>
        </div>
      </main>
    );
  }

  const view = onboardingView(await getOnboardingFacts(), new Date());
  if (view.show) {
    const host = (() => { try { return new URL(ws.origin).host; } catch { return ws.slug ?? ""; } })();
    return (
      <main>
        {head(false, true)}
        <Onboarding view={view} host={host} />
      </main>
    );
  }

  const data = await getConsoleData();
  return (
    <main>
      {head(true)}
      <ConsoleHome data={data} />
    </main>
  );
}

export default async function DashboardPage(...args: Parameters<typeof DashboardPageImpl>) {
  return withRequestTenant(() => DashboardPageImpl(...args));
}
