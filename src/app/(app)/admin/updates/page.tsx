import { requireCapability } from "@/lib/current-user";
import { db } from "@/lib/db";
import { getUpdateCheckConfig } from "@/lib/updates/update-check-config";
import { isConnectorOutdated } from "@/lib/updates/semver";
import { updateStatus } from "@/lib/updates/status";
import { connectorTunnelUrl } from "@/lib/url";
import { buildConnectorUpdateCommand } from "@/lib/connector/repair";
import { managerVersion } from "@/lib/version";
import { workspaceView } from "@/lib/mobile/views";
import { UpdatesView } from "./updates-view";
import { UpgradeGuide } from "./upgrade-guide";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Updates" };

async function AdminUpdatesPageImpl() {
  await requireCapability("configure");
  const [cfg, ws, connectors] = await Promise.all([
    getUpdateCheckConfig(),
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.connector.findMany({
      where: { status: { not: "REVOKED" } },
      select: { id: true, name: true, version: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const mgr = managerVersion();
  const behind = updateStatus(mgr, cfg?.latestVersion) === "behind";

  // The per-connector command only matters when an update is out and a connector
  // trails this console (the token volume is kept, so it's a plain update).
  const outdatedConnectors = connectors.filter((c) => isConnectorOutdated(c.version, mgr)).length;
  let connectorCommand: string | null = null;
  if (behind && outdatedConnectors > 0) {
    const managerUrl = process.env.MANAGER_PUBLIC_URL?.replace(/\/+$/, "") || "https://manager.<your-access-domain>";
    connectorCommand = buildConnectorUpdateCommand(managerUrl, connectorTunnelUrl());
  }

  return (
    <main className="up-main">
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Updates</h1>
          <p>Follow new releases of Captivo Access. Connectors running an older version than this console are flagged on the Connectors page.</p>
        </div>
      </div>
      <UpdatesView
        available={cfg !== null}
        initialEnabled={cfg?.enabled ?? true}
        running={mgr}
        latestVersion={cfg?.latestVersion ?? null}
        latestUrl={cfg?.latestUrl ?? null}
        lastCheckedAt={cfg?.lastCheckedAt ? cfg.lastCheckedAt.toISOString() : null}
        lastCheckOk={cfg?.lastCheckOk ?? null}
        connectors={connectors}
      />
      {behind && (
        <UpgradeGuide
          currentVersion={mgr}
          latestVersion={cfg?.latestVersion ?? ""}
          latestUrl={cfg?.latestUrl ?? null}
          connectorCommand={connectorCommand}
          outdatedConnectors={outdatedConnectors}
        />
      )}
    </main>
  );
}

export default async function AdminUpdatesPage(...args: Parameters<typeof AdminUpdatesPageImpl>) {
  return withRequestTenant(() => AdminUpdatesPageImpl(...args));
}
