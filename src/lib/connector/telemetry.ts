import { fetchWithTimeout } from "@/lib/net/fetch-timeout";

/** Reads counters from a connector. Rendered in a page, so it must not hang a render. */
const TELEMETRY_TIMEOUT_MS = 10_000;

export interface ConnectorTelemetry {
  version: string;
  uptimeSec: number;
  activeConnections: number;
  totalConnections: number;
  deniedCount: number;
  bytesIn: number;
  bytesOut: number;
  recentLogs?: string[];
  guacdLogs?: string[];
  kasmLogs?: string[];
  /** The host, as the install command passes it in (connector 2.25.0 and later). */
  hostname?: string;
  os?: string;
  localIp?: string;
  /** The updater beside the connector (2.41.0 and later); absent: none, or it stopped. */
  updater?: { version: string; dockerOk: boolean };
  /** The latest host action, as the updater reports it. */
  hostAction?: HostActionStatus;
}

export type HostActionState = "waiting_idle" | "preparing" | "applying" | "rolling_back" | "done" | "rolled_back" | "failed" | "removing";

export interface HostActionStatus {
  id: string;
  action: "update" | "uninstall";
  state: HostActionState;
  version?: string;
  from?: string;
  detail?: string;
  at?: string;
}

// Reads a connector's live telemetry from the data-plane (in-memory, ephemeral).
// Fail-soft: an unreachable data-plane returns { online: false } so the page still
// renders its DB fields.
export async function getConnectorTelemetry(
  connectorId: string,
): Promise<{ online: boolean; ageMs?: number; edgeLatencyMs?: number; telemetry?: ConnectorTelemetry | null; dataplaneDown?: boolean }> {
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const secret = process.env.DATAPLANE_SECRET || "";
  const res = await fetchWithTimeout(`${base}/connector-telemetry`, { timeoutMs: TELEMETRY_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": secret },
    body: JSON.stringify({ connectorId }),
  }).catch(() => null);
  // dataplaneDown: the question went unanswered, which is not the connector's fault.
  if (!res || !res.ok) return { online: false, dataplaneDown: true };
  return res.json();
}
