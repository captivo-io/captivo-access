import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { getSetupStatus } from "@/lib/dashboard/stats";
import { can, isConsoleUser, ROLE_LABELS } from "@/lib/auth/roles";
import { getConsoleData } from "@/lib/console/data";
import { workspaceView } from "@/lib/mobile/views";
import { ConsoleHome } from "./_console/console-home";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Console" };

async function DashboardPageImpl() {
  const user = await requireUser();
  if (!isConsoleUser(user.role)) {
    redirect("/access");
  }
  const ws = await workspaceView().catch(() => ({ name: "", slug: null as string | null }));
  const first = user.name.trim().split(/\s+/)[0] || user.name;
  const role = ROLE_LABELS[user.role] ?? user.role;

  const head = (actions: boolean) => (
    <div className="page-head">
      <div>
        <div className="eyebrow">
          Console{ws.slug ? ` · ${ws.slug}` : ""} <span className="chip violet">{role}</span>
        </div>
        <h1>Hello, {first}</h1>
      </div>
      {actions && (
        <div className="row-actions">
          <Link href="/admin/invites?new=1" className="btn">Invite vendor</Link>
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

  const setup = await getSetupStatus();
  const steps = [
    { done: setup.connectorsOnline >= 1, title: "Connect your network", hint: "Add a connector and run it inside your network so it comes online.", href: "/admin/connectors" },
    { done: setup.sites >= 1, title: "Add an internal app", hint: "Define a Resource for an app the connector can reach.", href: "/admin/sites" },
    { done: setup.grants >= 1, title: "Grant someone access", hint: "Tie a user to a resource — optionally time-boxed, approved, or scheduled.", href: "/admin/grants" },
  ];

  if (!steps.every((st) => st.done)) {
    return (
      <main>
        {head(false)}
        <div className="card">
          <div className="card-head"><h2>Getting started</h2></div>
          <ol className="checklist">
            {steps.map((st) => (
              <li key={st.href} className={st.done ? "done" : ""}>
                <span className="check" aria-hidden="true">{st.done ? "✓" : "○"}</span>
                <div>
                  <div className="ct">{st.title}</div>
                  <div className="ch">{st.hint}</div>
                </div>
                {!st.done && <Link className="btn sm" href={st.href}>Go →</Link>}
              </li>
            ))}
          </ol>
        </div>
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
