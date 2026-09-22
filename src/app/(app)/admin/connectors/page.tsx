import { ConnectorsIcon } from "@/components/icons";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { managerVersion } from "@/lib/version";
import { buildConnectorUpdateCommand } from "@/lib/connector/repair";
import { connectorTunnelUrl, isLocalManagerUrl } from "@/lib/url";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { AddConnectorButton } from "./add-connector-button";
import { ConnectorsTable, type ConnectorRow } from "./connectors-table";
import { DeletePairingButton } from "./delete-pairing-button";
import { withRequestTenant } from "@/lib/tenant/request";
import { planUsage } from "@/lib/platform/plan-usage";
import { PlanUsageNote } from "@/app/(app)/_shell/plan-usage-note";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connectors" };

async function AdminConnectorsPageImpl() {
  await requireAdmin();

  const connectors = await db.connector.findMany({
    select: { id: true, name: true, status: true, lastSeenAt: true, version: true, _count: { select: { sites: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Fresh-install pairings created but not yet redeemed (the connector hasn't
  // connected). Re-pair pairings (connectorId set) belong to a connector already
  // in the list above, so they're excluded here.
  const pendingPairings = await db.connectorPairing.findMany({
    where: { usedAt: null, connectorId: null },
    select: { id: true, name: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
  const now = Date.now();

  // Counted the same way assertWithinLimit counts it (api/admin/connectors):
  // a revoked connector does not occupy an allowance, so showing it here would
  // disagree with the gate that actually refuses the next one.
  const connectorUsage = await planUsage(
    "maxConnectors",
    await db.connector.count({ where: { status: { not: "REVOKED" } } }),
  );

  const mgr = managerVersion();
  const managerUrl = process.env.MANAGER_PUBLIC_URL?.replace(/\/+$/, "") || "https://manager.<your-access-domain>";
  const managerUrlIsLocal = isLocalManagerUrl(managerUrl);
  const updateCommand = buildConnectorUpdateCommand(managerUrl, connectorTunnelUrl());
  const rows: ConnectorRow[] = connectors.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
    version: c.version,
    sitesCount: c._count.sites,
  }));

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><ConnectorsIcon /></span><h1>Connectors</h1></div>
          <p>
            A connector is a small agent you run inside a customer&apos;s network. Pair one here, then add
            resources to expose specific internal upstreams through it.
          </p>
          <PlanUsageNote usage={connectorUsage} noun="connectors" />
        </div>
        <div className="row-actions">
          <AddConnectorButton />
        </div>
      </div>

      {connectors.length === 0 ? (
        <div className="empty">No connectors yet — use &quot;Add connector&quot; to reach an internal app.</div>
      ) : (
        <ConnectorsTable rows={rows} mgr={mgr} updateCommand={updateCommand} managerUrlIsLocal={managerUrlIsLocal} />
      )}

      {pendingPairings.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <div className="card-head"><div className="ch-title"><h2>Pending pairings</h2><span className="sub">Created but not yet connected — the connector appears above once it runs its install command.</span></div></div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pendingPairings.map((p) => {
                  const expired = p.expiresAt.getTime() < now;
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="cell-sub"><LocalTime iso={p.createdAt.toISOString()} /></td>
                      <td className="cell-sub">
                        {expired ? (
                          <span className="pill warn">Expired</span>
                        ) : (
                          <LocalTime iso={p.expiresAt.toISOString()} />
                        )}
                      </td>
                      <td><DeletePairingButton id={p.id} name={p.name} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

export default async function AdminConnectorsPage(...args: Parameters<typeof AdminConnectorsPageImpl>) {
  return withRequestTenant(() => AdminConnectorsPageImpl(...args));
}

