import { compareSemver } from "@/lib/updates/semver";
export { sshCommand } from "./native-ssh-command";

// Native SSH: a remote desktop resource on SSH that the user may also reach
// with their own SSH client (OpenSSH, VS Code, Termius, PuTTY) through the
// data plane's jump host (dataplane/sshjump.go).
//
// On a recorded resource the session is recorded: the jump host ends the
// user's SSH connection and the connector signs in to the server with the
// saved account (dataplane/sshrec.go, connector/sshproxy.go), so the terminal
// is recorded, file transfer follows the resource's rule and port forwarding
// is refused. That needs connector 2.49.0. On a resource that is not recorded,
// or a recorded one whose connector is older (while the Policy doesn't require
// recording), the connection runs straight between the client and the server
// and Captivo sees none of it.

/** Connectors relay the direct connection as the raw TCP stream native RDP brought in 2.39.0. */
export const NATIVE_SSH_MIN_CONNECTOR = "2.39.0";

/** Connectors sign in for a recorded session from this release on. */
export const NATIVE_SSH_RECORDED_MIN_CONNECTOR = "2.49.0";

/** How long a command can start connections. */
export const SSH_TICKET_TTL_MS = 2 * 60_000;

/** The jump host's public port when SSH_PUBLIC_PORT is not set. */
export const DEFAULT_SSH_PORT = 2222;

export type NativeSshBlock = "off" | "not_ssh" | "recording_required" | "connector_outdated";
export type NativeSshMode = "recorded" | "direct";

type NativeSshFacts = {
  accessMode: string; nativeSsh: boolean; protocol: string | null | undefined;
  /** Sessions on this resource are recorded (the Policy and its own setting). */
  recorded?: boolean;
  recordingRequired: boolean; connectorVersion: string | null | undefined;
};

/** How the user's own SSH client reaches this resource now, or why it can't. */
export function nativeSshMode(s: NativeSshFacts): NativeSshMode | NativeSshBlock {
  if (s.accessMode !== "GATEWAY" || String(s.protocol ?? "").toUpperCase() !== "SSH") return "not_ssh";
  if (!s.nativeSsh) return "off";
  const recorded = s.recorded || s.recordingRequired;
  if (recorded && compareSemver(s.connectorVersion, NATIVE_SSH_RECORDED_MIN_CONNECTOR) !== -1) return "recorded";
  if (s.recordingRequired) return "connector_outdated";
  if (compareSemver(s.connectorVersion, NATIVE_SSH_MIN_CONNECTOR) === -1) return "connector_outdated";
  return "direct";
}

/** Why a resource can't be reached with the user's own SSH client now, or null when it can. */
export function nativeSshBlock(s: NativeSshFacts): NativeSshBlock | null {
  const m = nativeSshMode(s);
  return m === "recorded" || m === "direct" ? null : m;
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
