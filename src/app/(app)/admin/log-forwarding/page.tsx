import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { managerVersion } from "@/lib/version";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { datadogSiteOf } from "@/lib/logforward/config";
import { LogForwarding, type DestinationView, type ConnectorOption } from "./log-forwarding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Log forwarding" };

/** Connectors from this release on can forward syslog (connector/logforward.go). */
const SYSLOG_SINCE = "2.42.0";

async function LogForwardingPageImpl() {
  await requireAdmin();
  const [rows, connectors, heads, ws] = await Promise.all([
    db.logDestination.findMany({ orderBy: { createdAt: "asc" } }),
    db.connector.findMany({ where: { status: { not: "REVOKED" } }, select: { id: true, name: true, status: true, version: true }, orderBy: { name: "asc" } }),
    db.auditChainState.findMany({ select: { scope: true, lastSeq: true } }),
    workspaceView().catch(() => ({ name: "", slug: null as string | null, origin: "" })),
  ]);
  const head = (scope: string) => heads.find((h) => h.scope === scope)?.lastSeq ?? BigInt(0);
  const destinations: DestinationView[] = rows.map((d) => ({
    id: d.id, name: d.name, enabled: d.enabled, kind: d.kind as DestinationView["kind"],
    transport: d.transport as DestinationView["transport"], host: d.host, port: d.port, framing: d.framing as DestinationView["framing"],
    format: d.format === "json" ? "json" : "cef", facility: d.facility, caPem: d.caPem ?? "",
    connectorId: d.connectorId, fallbackConnectorId: d.fallbackConnectorId,
    url: d.url, datadogSite: datadogSiteOf(d.url), headerName: d.headerName, hasSecret: !!d.secret,
    sendSessions: d.sendSessions, sendFiles: d.sendFiles, sendDenied: d.sendDenied, sendAdmin: d.sendAdmin, sendRequests: d.sendRequests,
    sentTotal: Number(d.sentTotal),
    // Records written since the cursors, before filtering: what is still to be read.
    behind: Number(head("access") - d.accessCursor + (head("admin") - d.adminCursor)),
    lastSentAt: d.lastSentAt?.toISOString() ?? null, lastError: d.lastError, lastErrorAt: d.lastErrorAt?.toISOString() ?? null,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
  }));
  const options: ConnectorOption[] = connectors.map((c) => ({ id: c.id, name: c.name, online: c.status === "ONLINE", version: c.version }));
  const host = (() => {
    try {
      return ws.origin ? new URL(ws.origin).hostname : "access.example.com";
    } catch {
      return "access.example.com";
    }
  })();

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Log forwarding</h1>
          <p>Send the audit log to your SIEM as it is written: over syslog through a connector on your network, or straight to a cloud service.</p>
        </div>
      </div>
      <LogForwarding
        destinations={destinations}
        connectors={options}
        syslogSince={SYSLOG_SINCE}
        cloud={multiTenantEnabled()}
        ctx={{ version: managerVersion(), hostname: host, workspace: ws.slug ?? (host.split(".")[0] || "default") }}
      />
    </main>
  );
}

export default async function LogForwardingPage(...args: Parameters<typeof LogForwardingPageImpl>) {
  return withRequestTenant(() => LogForwardingPageImpl(...args));
}
