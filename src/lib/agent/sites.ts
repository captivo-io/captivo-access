/** The resources an agent can connect to for now: an SSH resource (browser or recorded native) or a TCP tunnel, all through the SSH jump host. */
export function agentCanUse(s: { accessMode: string; vaultCredential?: { protocol: string } | null }): boolean {
  return s.accessMode === "TUNNEL" || (s.accessMode === "GATEWAY" && String(s.vaultCredential?.protocol ?? "").toUpperCase() === "SSH");
}
