// A connector installed as a program (a Windows service, a systemd unit) has no
// guacd or isolated browser beside it, unlike the Docker image. It serves what
// the connector itself speaks: web apps, databases, Kubernetes clusters and TCP
// tunnels. `Connector.platform` is "windows" or "linux" for it, null for the
// Docker image (set from the tunnel's handshake, internal/connector/status).

import { db } from "@/lib/db";

/** The access modes a connector installed as a program can serve. */
export const STANDALONE_ACCESS_MODES: readonly string[] = ["TRANSPARENT", "DATABASE", "KUBERNETES", "TUNNEL"];

export const isStandalone = (c: { platform?: string | null }) => !!c.platform;

export { platformLabel } from "@/lib/connector/platform-label";

export function connectorServes(c: { platform?: string | null }, accessMode: string): boolean {
  return !isStandalone(c) || STANDALONE_ACCESS_MODES.includes(accessMode);
}

/**
 * Whether the connector (or every member of the group) can serve a resource of
 * this kind; the names of the ones that cannot otherwise. Runs in the tenant's scope.
 */
export async function connectorsThatCannotServe(accessMode: string, connectorId: string | null, groupId: string | null): Promise<string[]> {
  if (STANDALONE_ACCESS_MODES.includes(accessMode)) return [];
  const rows = groupId
    ? await db.connectorGroupMember.findMany({ where: { groupId }, select: { connector: { select: { name: true, platform: true } } } }).then((r) => r.map((m) => m.connector))
    : connectorId ? await db.connector.findMany({ where: { id: connectorId }, select: { name: true, platform: true } }) : [];
  return rows.filter((c) => isStandalone(c)).map((c) => c.name);
}

export const NO_ENGINES_TEXT = "installed as a program, with no remote-desktop or isolated-browser engine beside it. It serves web apps, databases, Kubernetes clusters and TCP tunnels; use a connector installed with Docker for the rest.";
