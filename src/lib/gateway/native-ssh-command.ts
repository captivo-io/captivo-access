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
 * signs in themselves); left empty, a placeholder they replace.
 */
export function sshCommand(o: { code: string; jumpHost: string; jumpPort: number; targetHost: string; targetPort: number; user: string }): string {
  const user = o.user.trim();
  const who = user && shellSafe(user) ? user : "USER";
  // The destination takes a bare IPv6 address (ssh splits at the last @); -J needs brackets.
  const port = o.targetPort === 22 ? "" : ` -p ${o.targetPort}`;
  return `ssh -J ${o.code}@${jumpAuthority(o.jumpHost, o.jumpPort)}${port} ${who}@${o.targetHost}`;
}
