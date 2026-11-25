export type AgentKind = "ssh" | "tunnel" | "database" | "kubernetes" | "web" | "rdp";

/** What an agent connects to a resource as, or null when it cannot. */
export function agentKind(s: { accessMode: string; vaultCredential?: { protocol: string } | null }): AgentKind | null {
  if (s.accessMode === "TUNNEL") return "tunnel";
  if (s.accessMode === "DATABASE") return "database";
  if (s.accessMode === "KUBERNETES") return "kubernetes";
  if (s.accessMode === "TRANSPARENT") return "web";
  if (s.accessMode === "GATEWAY") {
    const p = String(s.vaultCredential?.protocol ?? "").toUpperCase();
    return p === "SSH" ? "ssh" : p === "RDP" ? "rdp" : null;
  }
  return null;
}

/**
 * The resources an agent can be given: SSH, TCP tunnels, databases, Kubernetes
 * clusters, web applications (it calls their API through the proxy) and remote
 * desktops through the RD Gateway (a recorded session for a tool that drives a
 * screen). Isolated browsers and VNC are for people.
 */
export function agentCanUse(s: { accessMode: string; vaultCredential?: { protocol: string } | null }): boolean {
  return agentKind(s) !== null;
}

export const AGENT_KIND_LABEL: Record<AgentKind, string> = { ssh: "SSH", tunnel: "TCP tunnel", database: "Database", kubernetes: "Kubernetes", web: "Web application", rdp: "Remote desktop" };
