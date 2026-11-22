// The command the portal shows for a user's own SSH client. Pure, and free of
// node imports: the portal's dialog builds it as the user types their name.

const shellSafe = (v: string) => /^[A-Za-z0-9._@%+=:,/-]+$/.test(v);

/** host:port for -J, with IPv6 in brackets. */
function jumpAuthority(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return port === 22 ? h : `${h}:${port}`;
}

/**
 * The command the portal shows. `user` is the account on the server (the user
 * signs in themselves); left empty, a placeholder they replace. A recorded
 * session (`hostKeyAlias` set) shows Captivo's key instead of the server's, so
 * the client files it under that name and never mistakes it for the server's.
 */
export function sshCommand(o: { code: string; jumpHost: string; jumpPort: number; targetHost: string; targetPort: number; user: string; hostKeyAlias?: string }): string {
  const user = o.user.trim();
  const who = user && shellSafe(user) ? user : "USER";
  // The destination takes a bare IPv6 address (ssh splits at the last @); -J needs brackets.
  const port = o.targetPort === 22 ? "" : ` -p ${o.targetPort}`;
  const alias = o.hostKeyAlias && shellSafe(o.hostKeyAlias) ? ` -o HostKeyAlias=${o.hostKeyAlias}` : "";
  return `ssh -J ${o.code}@${jumpAuthority(o.jumpHost, o.jumpPort)}${alias}${port} ${who}@${o.targetHost}`;
}

/** The name a recorded session's key is filed under in known_hosts. */
export function recordedHostKeyAlias(jumpHost: string): string {
  return `captivo-recorded.${jumpHost.replace(/[^A-Za-z0-9.-]/g, "")}`;
}
