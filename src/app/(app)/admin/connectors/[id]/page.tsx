import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { managerVersion } from "@/lib/version";
import { isConnectorOutdated } from "@/lib/updates/semver";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { getConnectorTelemetry } from "@/lib/connector/telemetry";
import { resolvedDefaultConnectorLogLevel } from "@/lib/settings/platform";
import { EgressPolicyForm } from "./egress-policy-form";
import { LogLevelForm } from "./log-level-form";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connector" };

const STATUS_PILL: Record<string, string> = { PENDING: "warn", ONLINE: "ok", OFFLINE: "neutral", REVOKED: "danger" };

// Colour a recent-log line by the severity token the connector prefixes after
// the timestamp (e.g. "2026/… ERROR upstream error …"). Unprefixed/older lines
// fall through to the neutral default.
function logLineClass(line: string): string {
  if (/\bERROR\b/.test(line)) return "lvl-error";
  if (/\bWARN\b/.test(line)) return "lvl-warn";
  if (/\bDEBUG\b/.test(line)) return "lvl-debug";
  return "";
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}
function humanDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

async function ConnectorDetailPageImpl({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const connector = await db.connector.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      version: true,
      lastSeenAt: true,
      remoteAddr: true,
      egressPolicy: true,
      logLevel: true,
      sites: { select: { id: true, name: true, hostname: true, probeOk: true }, orderBy: { name: "asc" } },
    },
  });
  if (!connector) notFound();

  const siteIds = connector.sites.map((s) => s.id);
  const [tele, activity] = await Promise.all([
    getConnectorTelemetry(connector.id),
    siteIds.length
      ? db.auditEvent.findMany({
          where: { siteId: { in: siteIds } },
          orderBy: { timestamp: "desc" },
          take: 25,
          select: { id: true, timestamp: true, userEmail: true, siteName: true, method: true, path: true, decision: true },
        })
      : Promise.resolve([]),
  ]);

  const defaultLogLevel = await resolvedDefaultConnectorLogLevel();
  const mgr = managerVersion();
  const outdated = isConnectorOutdated(connector.version, mgr);
  const t = tele.online ? tele.telemetry : null;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>{connector.name}</h1>
          <p>
            <span className={`pill ${STATUS_PILL[connector.status] ?? "neutral"}`}>{connector.status}</span>
          </p>
        </div>
        <Link href="/admin/connectors" className="btn sm">← All connectors</Link>
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Overview</h2><span className="sub">Identity &amp; status</span></div></div>
        <div className="defrows">
          <div className="defrow"><span className="dk">Version</span><span className="dv">{connector.version ?? "—"}{outdated && <span className="pill warn" style={{ marginLeft: ".4rem" }}>Outdated</span>}</span></div>
          <div className="defrow"><span className="dk">Last seen</span><span className="dv">{connector.lastSeenAt ? <LocalTime iso={connector.lastSeenAt.toISOString()} /> : "Never"}</span></div>
          <div className="defrow"><span className="dk">Remote address</span><span className="dv">{connector.remoteAddr ?? "—"}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Egress policy</h2><span className="sub">Narrows what this connector may reach</span></div></div>
        <EgressPolicyForm connectorId={connector.id} initial={connector.egressPolicy ?? ""} />
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Logging</h2><span className="sub">Verbosity, pushed live over the tunnel</span></div></div>
        <LogLevelForm connectorId={connector.id} initial={connector.logLevel} globalDefault={defaultLogLevel} />
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Live telemetry</h2><span className="sub">Reported every 10s while connected</span></div></div>
        {t ? (
          <div className="stat-grid">
            <div className="stat-card"><span className="k">Active connections</span><span className="v">{t.activeConnections}</span></div>
            <div className="stat-card"><span className="k">Total handled</span><span className="v">{t.totalConnections}</span></div>
            <div className="stat-card"><span className="k">Uptime</span><span className="v">{humanDuration(t.uptimeSec)}</span></div>
            <div className={`stat-card ${t.deniedCount > 0 ? "warn" : "neutral"}`}><span className="k">Denied attempts</span><span className="v">{t.deniedCount}</span></div>
            <div className="stat-card"><span className="k">Bytes in</span><span className="v">{humanBytes(t.bytesIn)}</span></div>
            <div className="stat-card"><span className="k">Bytes out</span><span className="v">{humanBytes(t.bytesOut)}</span></div>
          </div>
        ) : (
          <p className="cell-sub">No live data — the connector is offline or hasn&apos;t been updated to report telemetry yet.</p>
        )}
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Resources on this connector</h2><span className="sub">Apps routed through it</span></div></div>
        {connector.sites.length === 0 ? (
          <div className="empty">No resources yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Hostname</th><th>Health</th></tr></thead>
              <tbody>
                {connector.sites.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="cell-sub">{s.hostname}</td>
                    <td>{s.probeOk == null ? <span className="pill neutral">Not checked</span> : s.probeOk ? <span className="pill ok">Reachable</span> : <span className="pill danger">Unreachable</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" id="logs" style={{ scrollMarginTop: 90 }}>
        <div className="card-head"><div className="ch-title"><h2>Recent logs</h2><span className="sub">Last lines from the connector</span></div></div>
        {t && t.recentLogs && t.recentLogs.length > 0 ? (
          <div className="term">
            <div className="term-body" style={{ maxHeight: "18rem" }}>
              {t.recentLogs.map((line, i) => (
                <div key={i} className={`term-line ${logLineClass(line)}`}>{line}</div>
              ))}
            </div>
          </div>
        ) : (
          <p className="cell-sub">No logs yet — the connector is offline or hasn&apos;t been updated to report logs.</p>
        )}
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Gateway logs</h2><span className="sub">Last lines from guacd (remote-desktop engine)</span></div></div>
        {t && t.guacdLogs && t.guacdLogs.length > 0 ? (
          <div className="term">
            <div className="term-body" style={{ maxHeight: "18rem" }}>
              {t.guacdLogs.map((line, i) => (
                <div key={i} className={`term-line ${logLineClass(line)}`}>{line}</div>
              ))}
            </div>
          </div>
        ) : (
          <p className="cell-sub">No guacd logs yet — the connector is offline, or hasn&apos;t been updated to report gateway logs (re-run its command).</p>
        )}
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Isolated browser logs</h2><span className="sub">Last lines from the isolated browser engine (KasmVNC)</span></div></div>
        {t && t.kasmLogs && t.kasmLogs.length > 0 ? (
          <div className="term">
            <div className="term-body" style={{ maxHeight: "18rem" }}>
              {t.kasmLogs.map((line, i) => (
                <div key={i} className={`term-line ${logLineClass(line)}`}>{line}</div>
              ))}
            </div>
          </div>
        ) : (
          <p className="cell-sub">No isolated-browser logs yet — the connector is offline, or hasn&apos;t been updated to report them (re-run its command).</p>
        )}
      </div>

      <div className="card">
        <div className="card-head"><div className="ch-title"><h2>Recent activity</h2><span className="sub">Latest access decisions on its resources</span></div></div>
        {activity.length === 0 ? (
          <div className="empty">No access activity yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>User</th><th>Resource</th><th>Request</th><th>Decision</th></tr></thead>
              <tbody>
                {activity.map((e) => (
                  <tr key={e.id}>
                    <td className="cell-sub"><LocalTime iso={e.timestamp.toISOString()} /></td>
                    <td className="cell-sub">{e.userEmail ?? "—"}</td>
                    <td className="cell-sub">{e.siteName ?? "—"}</td>
                    <td className="cell-sub" style={{ maxWidth: "22ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.method} {e.path}</td>
                    <td><span className={`pill ${e.decision === "ALLOW" ? "ok" : "danger"}`}>{e.decision === "ALLOW" ? "Allowed" : "Denied"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

export default async function ConnectorDetailPage(...args: Parameters<typeof ConnectorDetailPageImpl>) {
  return withRequestTenant(() => ConnectorDetailPageImpl(...args));
}

