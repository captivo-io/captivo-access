import Link from "next/link";
import { withRequestTenant } from "@/lib/tenant/request";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { platformSnapshot, recentActivity } from "@/lib/platform/overview";
import { formatBytes } from "@/lib/platform/tenant-shape";
import { managerVersion } from "@/lib/version";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { StatCard, AlertList, SectionHead } from "../_shell/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Platform overview" };

export default async function OverviewPage() {
  const { snap, activity } = await withRequestTenant(async () => {
    await requirePlatformAdmin();
    const [snap, activity] = await Promise.all([platformSnapshot(), recentActivity(10)]);
    return { snap, activity };
  });
  const t = snap.totals;
  const danger = snap.alerts.filter((a) => a.level === "danger").length;
  const warn = snap.alerts.filter((a) => a.level === "warn").length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Everything running on this platform, at a glance. Manager {managerVersion()}.</p>
        </div>
        <Link className="btn primary" href="/platform/new">New tenant</Link>
      </div>

      <div className="stat-grid">
        <StatCard k="Tenants" v={t.tenants} sub={<>{t.active} active · {t.suspended} suspended{t.deleted ? ` · ${t.deleted} deleted` : ""}</>} />
        <StatCard k="Users" v={t.users} sub={<>{t.vendors} vendors</>} />
        <StatCard k="Sessions · 24h" v={t.sessions24h} sub="console + portal logins" />
        <StatCard k="Connectors online" v={<>{t.connectorsOnline}<span className="cell-sub"> / {t.connectors}</span></>} tone={t.connectors > 0 && t.connectorsOnline === 0 ? "danger" : t.connectorsOnline < t.connectors ? "warn" : "ok"} />
        <StatCard k="Resources" v={t.sites} sub={<>{t.grantsActive} active grants · {t.requestsPending} pending</>} />
        <StatCard k="Recordings" v={formatBytes(t.recordingBytes)} sub={<>{t.recordings} sessions</>} />
        <StatCard k="Alerts" v={snap.alerts.length} sub={<>{danger} need action · {warn} warnings</>} tone={danger ? "danger" : warn ? "warn" : "ok"} />
      </div>

      <div className="card">
        <SectionHead title="Alerts" sub="Trials, suspensions, provisioning and background-job problems across every tenant." action={<Link href="/platform/jobs" className="btn sm">Jobs & provisioning</Link>} />
        <AlertList alerts={snap.alerts} limit={12} />
        {snap.alerts.length > 12 ? <p className="cell-sub" style={{ marginTop: 8 }}>{snap.alerts.length - 12} more on the Tenants and Jobs pages.</p> : null}
      </div>

      <div className="dash-cols">
        <div className="card">
          <SectionHead title="Recent admin activity" sub="Latest admin actions across the platform and every tenant." action={<Link href="/platform/activity" className="btn sm">All activity</Link>} />
          {activity.admin.length === 0 ? <div className="empty">Nothing yet.</div> : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {activity.admin.map((e) => (
                    <tr key={e.id}>
                      <td className="cell-sub" style={{ width: 1 }}><LocalTime iso={new Date(e.timestamp).toISOString()} mode="short" /></td>
                      <td><Link href={`/platform/tenants/${e.tenantId}`} className="link-button">{e.slug}</Link></td>
                      <td className="cell-sub" style={{ whiteSpace: "normal" }}>{e.summary}<div className="cell-sub">{e.actorEmail ?? "system"} · {e.action}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <SectionHead title="Recent access" sub="Latest vendor access decisions across all tenants." />
          {activity.access.length === 0 ? <div className="empty">No access events yet.</div> : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {activity.access.map((e) => (
                    <tr key={e.id}>
                      <td className="cell-sub" style={{ width: 1 }}><LocalTime iso={new Date(e.timestamp).toISOString()} mode="short" /></td>
                      <td><Link href={`/platform/tenants/${e.tenantId}`} className="link-button">{e.slug}</Link></td>
                      <td className="cell-sub"><span className={`pill ${e.decision === "ALLOW" ? "ok" : "danger"}`}>{e.decision}</span></td>
                      <td className="cell-sub" style={{ whiteSpace: "normal" }}>{e.userEmail ?? "—"} → {e.siteName ?? e.host}{e.reason ? ` · ${e.reason}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
