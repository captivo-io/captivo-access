import { compareSemver } from "@/lib/updates/semver";
export { sshCommand } from "./native-ssh-command";

// Native SSH: a remote desktop resource on SSH that the user may also reach
// with their own SSH client (OpenSSH, VS Code, Termius, PuTTY) through the
// data plane's jump host (dataplane/sshjump.go). The SSH session runs between
// that client and the server, so Captivo can't record it, log keystrokes, sign
// in for the user or let an admin watch: like native RDP, it is offered only
// where the resource asks for none of that.

/** Connectors relay it as the raw TCP stream native RDP brought in 2.39.0. */
export const NATIVE_SSH_MIN_CONNECTOR = "2.39.0";

/** How long a command can start connections. */
export const SSH_TICKET_TTL_MS = 2 * 60_000;

/** The jump host's public port when SSH_PUBLIC_PORT is not set. */
export const DEFAULT_SSH_PORT = 2222;

export type NativeSshBlock = "off" | "not_ssh" | "recorded" | "connector_outdated";

/** Why a resource can't be reached with the user's own SSH client now, or null when it can. */
export function nativeSshBlock(s: { accessMode: string; nativeSsh: boolean; protocol: string | null | undefined; recorded: boolean; connectorVersion: string | null | undefined }): NativeSshBlock | null {
  if (s.accessMode !== "GATEWAY" || String(s.protocol ?? "").toUpperCase() !== "SSH") return "not_ssh";
  if (!s.nativeSsh) return "off";
  if (s.recorded) return "recorded";
  if (compareSemver(s.connectorVersion, NATIVE_SSH_MIN_CONNECTOR) === -1) return "connector_outdated";
  return null;
}

/** The jump host's public name: SSH_PUBLIC_HOST, else the console's own host. */
export function sshPublicHost(consoleHost: string): string {
  return process.env.SSH_PUBLIC_HOST?.trim() || consoleHost;
}

/** The jump host's public port. */
export function sshPublicPort(): number {
  const n = Number(process.env.SSH_PUBLIC_PORT ?? DEFAULT_SSH_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_SSH_PORT;
}
