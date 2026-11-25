export type AgentKind = "ssh" | "tunnel" | "database" | "kubernetes";

/** What an agent connects to a resource as, or null when it cannot (yet). */
export function agentKind(s: { accessMode: string; vaultCredential?: { protocol: string } | null }): AgentKind | null {
  if (s.accessMode === "TUNNEL") return "tunnel";
  if (s.accessMode === "DATABASE") return "database";
  if (s.accessMode === "KUBERNETES") return "kubernetes";
  if (s.accessMode === "GATEWAY" && String(s.vaultCredential?.protocol ?? "").toUpperCase() === "SSH") return "ssh";
  return null;
}

/** The resources an agent can connect to: SSH (browser or recorded native), TCP tunnels, databases and Kubernetes clusters. Remote desktops and web apps are for people. */
export function agentCanUse(s: { accessMode: string; vaultCredential?: { protocol: string } | null }): boolean {
  return agentKind(s) !== null;
}

export const AGENT_KIND_LABEL: Record<AgentKind, string> = { ssh: "SSH", tunnel: "TCP tunnel", database: "Database", kubernetes: "Kubernetes" };
