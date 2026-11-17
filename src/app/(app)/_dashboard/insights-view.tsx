import Link from "next/link";
import type { DashboardStats } from "@/lib/dashboard/stats";
import type { Insights, TrendDay } from "@/lib/dashboard/insights";
import { Heatmap } from "./heatmap";
import { ExportCsvButton } from "./export-csv";
import { Empty } from "../_console/console-home";

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

/**
 * Insights as the design hand-off lays them out: the range control, six KPI
 * cards (each with its trend and a status line), daily vendor access stacked
 * accessed / blocked, traffic by hour, denials, access type, and the most used
 * resources and most active vendors.
 */
export function InsightsView({ stats, insights, range }: { stats: DashboardStats; insights: Insights; range: Range }) {
  const t = insights.trend;
  const allowSeries = t.map((d) => d.allow);
  const denySeries = t.map((d) => d.deny);
  const blocked = denySeries.reduce((a, b) => a + b, 0);
  const conOff = stats.connectors - stats.connectorsOnline;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Insights · last {range} days</div>
          <h1>Insights</h1>
          <p>Who reached what, when, and what the policy stopped.</p>
        </div>
        <div className="row-actions">
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <Link key={r} href={`/admin/insights?range=${r}`} className={r === range ? "seg-opt on" : "seg-opt"} aria-pressed={r === range}>
                {r} days
              </Link>
            ))}
          </div>
          <ExportCsvButton insights={insights} range={range} />
        </div>
      </div>

      <div className="ik-grid">
        <KpiCard href="/admin/audit" label="Active vendors" value={insights.activeVendors.count} series={allowSeries}
          status={{ tone: "ok", text: `reached a resource in ${range} days` }} />
        <KpiCard href="/admin/audit?decision=DENY" label="Blocked attempts" value={blocked} series={denySeries} seriesTone="bad"
          status={blocked > 0 ? { tone: "warn", text: `${insights.deny.reasons[0]?.label ?? "denied"} most often` } : { tone: "ok", text: "nothing blocked" }} />
        <KpiCard href="/admin/sites" label="Resources reachable" value={`${stats.sitesReachable}/${stats.sites}`}
          status={stats.sitesDown > 0 ? { tone: "warn", text: `${stats.sitesDown} resource${stats.sitesDown === 1 ? "" : "s"} unreachable` } : { tone: "ok", text: "all reachable" }} />
        <KpiCard href="/admin/connectors" label="Connectors online" value={`${stats.connectorsOnline}/${stats.connectors}`}
          status={conOff > 0 ? { tone: "warn", text: `${conOff} offline` } : { tone: "ok", text: stats.connectors > 0 ? "all online" : "none yet" }} />
        <KpiCard href="/admin/recordings" label="Recorded sessions" value={insights.sessionStats.recordings}
          status={{ tone: "muted", text: insights.sessionStats.recordings > 0 ? `avg ${insights.sessionStats.avgMinutes}m · ${insights.sessionStats.totalHours}h in total` : "no recordings in range" }} />
        <KpiCard href="/admin/grants" label="Expiring in 7 days" value={insights.expiring.count}
          status={insights.expiring.count > 0 ? { tone: "warn", text: `next: ${insights.expiring.soonest[0]?.siteName ?? "—"}` } : { tone: "muted", text: "nothing ending soon" }} />
      </div>

      <section className="card">
        <div className="card-head">
          <div className="ch-title"><h2>Vendor access</h2><span className="sub">distinct vendors per day</span></div>
          <div className="legend">
            <span><i className="lg-p" /> Accessed <b>{allowSeries.reduce((a, b) => a + b, 0)}</b></span>
            <span><i className="lg-bad" /> Blocked <b>{blocked}</b></span>
          </div>
        </div>
        <StackedBars days={t} />
      </section>

      <div className="ik-two">
        <section className="card"><Heatmap heatmap={insights.heatmap} rangeDays={range} /></section>
        <section className="card">
          <div className="card-head"><div className="ch-title"><h2>Denials</h2><span className="sub">by reason</span></div><span className="count">{insights.deny.total}</span></div>
          {insights.deny.total === 0 ? (
            <Empty icon="shield" ok title="No denial reasons" text={`Nothing was refused in the last ${range} days.`} />
          ) : (
            <HBars items={insights.deny.reasons.map((r) => ({ key: r.label, label: r.label, count: r.count }))} tone="bad" />
          )}
          {insights.ipFlags.length > 0 && (
            <div className="ik-flags">
              <p className="ik-flags-h">Signed in from several addresses</p>
              {insights.ipFlags.slice(0, 4).map((f) => (
                <div key={f.userEmail} className="ik-flag"><span>{f.userEmail}</span><span className="mono t-warn">{f.ipCount} IPs</span></div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="ik-three">
        <section className="card">
          <div className="card-head"><h2>Access type</h2></div>
          <Donut web={insights.typeMix.web} remote={insights.typeMix.remote} />
        </section>
        <section className="card">
          <div className="card-head"><div className="ch-title"><h2>Most used resources</h2><span className="sub">days active</span></div></div>
          {insights.topResources.length === 0 ? (
            <Empty icon="server" title="No access yet" text="Resources reached in this period are ranked here." />
          ) : (
            <HBars items={insights.topResources.map((r) => ({ key: r.id, label: r.label, count: r.count, href: `/admin/audit?siteId=${encodeURIComponent(r.id)}` }))} tone="p" />
          )}
        </section>
        <section className="card">
          <div className="card-head"><div className="ch-title"><h2>Most active vendors</h2><span className="sub">days active</span></div></div>
          {insights.topVendors.length === 0 ? (
            <Empty icon="users" title="No vendor activity" text="Vendors who reached a resource in this period are ranked here." />
          ) : (
            <HBars avatars items={insights.topVendors.map((r) => ({ key: r.id, label: r.label, count: r.count, href: `/admin/audit?userId=${encodeURIComponent(r.id)}` }))} tone="a" />
          )}
        </section>
      </div>
    </>
  );
}

function KpiCard({ href, label, value, series, seriesTone = "p", status }: {
  href: string; label: string; value: number | string; series?: number[]; seriesTone?: "p" | "bad";
  status: { tone: "ok" | "warn" | "muted"; text: string };
}) {
  const last = (series ?? []).slice(-10);
  const max = Math.max(1, ...last);
  return (
    <Link href={href} className="ik-card">
      <span className="kcell-k">{label}</span>
      <span className="ik-mid">
        <span className="kcell-v">{value}</span>
        {last.length > 0 && (
          <span className={`spark ${seriesTone}`} aria-hidden="true">
            {last.map((v, i) => <i key={i} style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: v === 0 ? 0.25 : 1 }} />)}
          </span>
        )}
      </span>
      <span className={`ik-status ${status.tone}`}><span className="cx-sdot" aria-hidden="true" />{status.text}</span>
    </Link>
  );
}

/** Daily bars, accessed (primary) with blocked stacked on top. */
function StackedBars({ days }: { days: TrendDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.allow + d.deny));
  const top = niceMax(max);
  const every = days.length > 45 ? 15 : days.length > 14 ? 5 : 1;
  return (
    <div className="sbars">
      <div className="sbars-y" aria-hidden="true">
        <span>{top}</span><span>{Math.round(top / 2)}</span><span>0</span>
      </div>
      <div className="sbars-plot">
        <div className="sbars-grid" aria-hidden="true"><i /><i /><i /></div>
        <div className="sbars-cols">
          {days.map((d) => (
            <div key={d.date} className="sbars-col" title={`${d.date}: ${d.allow} accessed, ${d.deny} blocked`}>
              {/* column-reverse: the first is the bottom of the stack */}
              <span className="sb-p" style={{ height: `${(d.allow / top) * 100}%` }} />
              <span className="sb-bad" style={{ height: `${(d.deny / top) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="sbars-x" aria-hidden="true">
          {days.map((d, i) => <span key={d.date}>{i % every === 0 ? d.date.slice(5).replace("-", "/") : ""}</span>)}
        </div>
      </div>
    </div>
  );
}

function HBars({ items, tone, avatars }: { items: { key: string; label: string; count: number; href?: string }[]; tone: "p" | "a" | "bad"; avatars?: boolean }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="hbars">
      {items.map((it) => {
        const body = (
          <>
            {avatars && <span className="hb-av" aria-hidden="true">{initials(it.label)}</span>}
            <span className="hb-main">
              <span className="hb-top"><span className="hb-l">{it.label}</span><span className="mono t-muted">{it.count}</span></span>
              <span className="hb-track"><span className={`hb-fill ${tone}`} style={{ width: `${(it.count / max) * 100}%` }} /></span>
            </span>
          </>
        );
        return it.href ? <Link key={it.key} href={it.href} className="hb-row">{body}</Link> : <div key={it.key} className="hb-row">{body}</div>;
      })}
    </div>
  );
}

function Donut({ web, remote }: { web: number; remote: number }) {
  const total = web + remote;
  const pct = total > 0 ? (web / total) * 100 : 0;
  return (
    <div className="donut-wrap">
      <div
        className="donut"
        style={{ background: total > 0 ? `conic-gradient(var(--p) 0 ${pct}%, var(--a) ${pct}% 100%)` : "rgba(var(--ink-rgb),.08)" }}
        role="img"
        aria-label={`Web ${web}, remote ${remote}`}
      >
        <span className="donut-hole"><b>{total}</b><span>sessions</span></span>
      </div>
      <div className="legend legend-col">
        <span><i className="lg-p" /> Web <b>{web}</b></span>
        <span><i className="lg-a" /> Remote <b>{remote}</b></span>
      </div>
    </div>
  );
}

function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= n) ?? 10;
  return step * pow;
}
function initials(s: string): string {
  const base = s.includes("@") ? s.split("@")[0] : s;
  return (base.split(/[\s._-]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();
}
