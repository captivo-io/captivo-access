import { compareSemver } from "@/lib/updates/semver";

// TCP tunnel resources: any TCP service inside the network (Redis, MongoDB,
// Oracle, a vendor's own console, a Kubernetes API) for the user's own app.
// The portal hands out an ssh -L command whose jump user is a ticket; the jump
// host (dataplane/sshjump.go, sshtunnel.go) forwards every connection the
// command carries to this one resource through its connector, whatever the
// command was edited to ask for. Captivo sees only who, when and how much:
// the bytes are the app's own protocol, so these sessions are never recorded
// or watched, and a workspace that requires recording can't open them.

/** Connectors relay a raw TCP stream from 2.39.0 on (native RDP brought it). */
export const TUNNEL_MIN_CONNECTOR = "2.39.0";

export type TunnelBlock = "not_tunnel" | "recording_required" | "connector_outdated";

/** Why this resource can't be tunnelled to now, or null when it can. */
export function tunnelBlock(s: { accessMode: string; recordingRequired: boolean; connectorVersion: string | null | undefined }): TunnelBlock | null {
  if (s.accessMode !== "TUNNEL") return "not_tunnel";
  if (s.recordingRequired) return "recording_required";
  if (compareSemver(s.connectorVersion, TUNNEL_MIN_CONNECTOR) === -1) return "connector_outdated";
  return null;
}

/** The local port the command suggests: the service's own, or 10000 above it when only an administrator may listen there. */
export function suggestedLocalPort(targetPort: number): number {
  return targetPort >= 1024 ? targetPort : 10000 + targetPort;
}

export function validLocalPort(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}

/**
 * The command the portal shows. It listens on the user's own computer at
 * `localPort` and stops at once when that port is taken, instead of leaving a
 * window open that forwards nothing.
 */
export function tunnelCommand(o: { code: string; jumpHost: string; jumpPort: number; targetHost: string; targetPort: number; localPort: number }): string {
  const target = o.targetHost.includes(":") ? `[${o.targetHost}]` : o.targetHost;
  const port = o.jumpPort === 22 ? "" : ` -p ${o.jumpPort}`;
  return `ssh -L ${o.localPort}:${target}:${o.targetPort} -o ExitOnForwardFailure=yes${port} ${o.code}@${o.jumpHost}`;
}
