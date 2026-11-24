import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { managerVersion } from "@/lib/version";
import { buildConnectorUpdateCommand } from "@/lib/connector/repair";
import { buildFullBackupCommand, buildFullRestoreCommand, buildKeysBackupCommand, buildKeysRestoreCommand } from "@/lib/connector/backup";
import { BackupConnectorButton } from "./backup-connector-button";
import { connectorTunnelUrl, isLocalManagerUrl } from "@/lib/url";
import { ConnectorsView, type ConnectorCard } from "./connectors-view";
import { InstallPanel, AddConnectorScroll } from "./install-panel";
import { GroupsPanel, type GroupCard } from "./groups-panel";
import { sealsOf } from "@/lib/vault/store";
import { canReshare } from "@/lib/vault/reshare";
import { memberProbes } from "@/lib/connector/route";
import { listActiveSessions } from "@/lib/dataplane/client";
import { withRequestTenant } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { planUsage } from "@/lib/platform/plan-usage";
import { PlanUsageNote } from "@/app/(app)/_shell/plan-usage-note";
import { planAddBlocked } from "@/lib/platform/plan-usage";
import { isConnectorOutdated } from "@/lib/updates/semver";
import { getConnectorTelemetry } from "@/lib/connector/telemetry";
import { liveHostAction, remoteControl, storedHostAction, updateTarget } from "@/lib/connector/host-action";
import { dayKey, summarizeUptime } from "@/lib/connector/history";
import type { EventLevel } from "@/lib/connector/history";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connectors" };

async function AdminConnectorsPageImpl() {
  await requireAdmin();

  const now = new Date();
  const connectors = await db.connector.findMany({
    select: {
      id: true, name: true, status: true, lastSeenAt: true, version: true, createdAt: true, remoteAddr: true, tunnelSpark: true, hostAction: true,
      sites: { select: { probeOk: true } },
      groupMemberships: { select: { standby: true, group: { select: { name: true } } } },
      days: { where: { day: { gte: dayKey(new Date(now.getTime() - 30 * 86_400_000)) } }, select: { day: true, samples: true, online: true } },
      events: { orderBy: { at: "desc" }, take: 8, select: { at: true, level: true, text: true } },
    },
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
  const updateCommand = { remote: buildConnectorUpdateCommand(managerUrl, connectorTunnelUrl()), manual: buildConnectorUpdateCommand(managerUrl, connectorTunnelUrl(), false) };

  // Live counters straight from the data-plane, all at once (fail-soft: an
  // unanswered one only blanks that card's live figures).
  const live = await Promise.all(
    connectors.map((c) => (c.status === "REVOKED" ? Promise.resolve(null) : getConnectorTelemetry(c.id).catch(() => null))),
  );
  const cards: ConnectorCard[] = connectors.map((c, i) => {
    const t = live[i]?.online ? live[i]?.telemetry : null;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      version: c.version,
      outdated: isConnectorOutdated(c.version, mgr),
      createdAt: c.createdAt.toISOString(),
      lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
      signalAgeMs: live[i]?.online ? (live[i]?.ageMs ?? null) : null,
      remoteAddr: c.remoteAddr,
      hostname: t?.hostname || null,
      os: t?.os || null,
      localIp: t?.localIp || null,
      edgeLatencyMs: live[i]?.online ? (live[i]?.edgeLatencyMs ?? null) : null,
      uptimeSec: t?.uptimeSec ?? null,
      activeTunnels: t?.activeConnections ?? null,
      totalConnections: t?.totalConnections ?? null,
      deniedCount: t?.deniedCount ?? null,
      bytesIn: t?.bytesIn ?? null,
      bytesOut: t?.bytesOut ?? null,
      spark: c.tunnelSpark,
      resources: c.sites.length,
      unreachable: c.sites.filter((s) => s.probeOk === false).length,
      uptime: summarizeUptime(c.days, now),
      events: c.events.map((e) => ({ at: e.at.toISOString(), level: e.level as EventLevel, text: e.text })),
      remote: remoteControl(!!live[i]?.online && c.status === "ONLINE", t, c.createdAt),
      target: updateTarget(c.version, mgr),
      hostAction: liveHostAction(t?.hostAction ?? null, storedHostAction(c.hostAction), now),
      stored: storedHostAction(c.hostAction),
      groups: c.groupMemberships.map((m) => ({ name: m.group.name, standby: m.standby })),
    };
  });

  // Connector groups, with what each member cannot do for the group's resources.
  const groupRows = await db.connectorGroup.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true, name: true,
      members: { orderBy: [{ standby: "asc" }, { createdAt: "asc" }], select: { standby: true, connector: { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } } } },
      sites: { orderBy: { name: "asc" }, select: { name: true, accessMode: true, probeByConnector: true, vaultCredential: { select: { secret: true, sealedTo: true, extraSeals: true } } } },
    },
  });
  // Sessions each member carries now, from the dataplane (fail-soft: unknown on error).
  const carried = groupRows.length ? await listActiveSessions().catch(() => null) : null;
  const sessionsOf = (id: string, status: string) => (carried && status === "ONLINE" ? carried.filter((x) => x.connectorId === id).length : null);
  const groups: GroupCard[] = groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    resources: g.sites.map((s) => s.name),
    members: g.members.map(({ standby, connector: m }) => ({
      id: m.id, name: m.name, status: m.status, version: m.version, standby,
      sessions: sessionsOf(m.id, m.status),
      ...missingCopies(m, g),
      // As routing reads it: a member is short only where another member gets through;
      // a target nobody reaches is the resource's problem (shown on Resources).
      unreachable: g.sites.filter((s) => {
        const p = memberProbes(s.probeByConnector);
        return p[m.id]?.ok === false && Object.values(p).some((x) => x.ok);
      }).map((s) => s.name),
    })),
  }));
  const active = connectors.filter((c) => c.status !== "REVOKED").length;

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Infrastructure · {active} connector{active === 1 ? "" : "s"}</div>
          <h1>Connectors</h1>
          <p>
            A connector is a small agent inside your network. It dials out to Captivo, so no inbound ports are
            needed, and serves the resources you add on it.
          </p>
          <PlanUsageNote usage={connectorUsage} noun="connectors" one="connector" />
        </div>
        <div className="row-actions">
          {connectors.length > 0 && (
            <BackupConnectorButton
              commands={{ keysBackup: buildKeysBackupCommand(), fullBackup: buildFullBackupCommand(), keysRestore: buildKeysRestoreCommand(), fullRestore: buildFullRestoreCommand() }}
            />
          )}
          <AddConnectorScroll blockedReason={planAddBlocked(connectorUsage, "connector")} />
        </div>
      </div>

      {cards.length > 0 && <GroupsPanel groups={groups} connectors={cards.map((c) => ({ id: c.id, name: c.name, status: c.status }))} />}

      {cards.length > 0 && <ConnectorsView connectors={cards} mgr={mgr} updateCommand={updateCommand} managerUrlIsLocal={managerUrlIsLocal} />}

      <InstallPanel
        first={cards.length === 0}
        blockedReason={planAddBlocked(connectorUsage, "connector")}
        pending={pendingPairings.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString(), expiresAt: p.expiresAt.toISOString() }))}
      />
    </main>
  );
}

export default async function AdminConnectorsPage(...args: Parameters<typeof AdminConnectorsPageImpl>) {
  // Reads every connector's live counters: up to the telemetry timeout, so the slow budget.
  return withRequestTenant(() => AdminConnectorsPageImpl(...args), { budgetMs: SLOW_SCOPE_BUDGET_MS });
}

type GroupMemberRow = { status: string; version: string | null; vaultPublicKey: string | null };

// The group resources whose saved password a member cannot open: `copying` when
// another member that has a copy can give it one now (lib/vault/reshare.ts, on
// the next health pass at the latest), `waiting` when such a member is offline,
// `noSeal` when no member that has a copy is new enough to give it.
function missingCopies(m: GroupMemberRow, g: { members: { connector: GroupMemberRow }[]; sites: { name: string; accessMode: string; vaultCredential: { secret: string; sealedTo: string | null; extraSeals: unknown } | null }[] }) {
  const copying: string[] = [];
  const waiting: string[] = [];
  const noSeal: string[] = [];
  for (const s of g.sites) {
    if ((s.accessMode !== "GATEWAY" && s.accessMode !== "DATABASE" && s.accessMode !== "KUBERNETES") || !s.vaultCredential?.sealedTo) continue;
    const seals = sealsOf(s.vaultCredential);
    if (m.vaultPublicKey && seals[m.vaultPublicKey]) continue;
    const holders = g.members.map((x) => x.connector).filter((o) => o.status !== "REVOKED" && o.vaultPublicKey && seals[o.vaultPublicKey]);
    const list = !m.vaultPublicKey ? noSeal
      : holders.some((o) => canReshare(o)) ? copying
      : holders.some((o) => canReshare({ ...o, status: "ONLINE" })) ? waiting
      : noSeal;
    list.push(s.name);
  }
  return { copying, waiting, noSeal };
}
