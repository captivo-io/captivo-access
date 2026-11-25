import { compareSemver } from "@/lib/updates/semver";

// Administrator rights for the length of a session (zero standing privilege):
// an account that is an ordinary user all day is given administrator rights
// while someone has a session on it, and loses them when the last one closes
// (connector/elevate.go). Linux: a sudoers entry. Windows: membership of the
// local Administrators group. The resource's reconcile account (root or a
// sudoer; the built-in Administrator) does the change.

/** Recorded native SSH on Linux: connectors from this release give and take away the entry. */
export const ELEVATE_MIN_CONNECTOR = "2.71.0";
/** Browser sessions (SSH and RDP), recorded native RDP, and Windows servers. */
export const ELEVATE_SESSIONS_MIN_CONNECTOR = "2.75.0";

export type ElevatePlatform = "linux" | "windows";
export type ElevateBlock =
  | "elevate_ssh_only" | "elevate_needs_native" | "elevate_needs_recording" | "elevate_needs_account" | "elevate_root" | "elevate_windows_local";

export const ELEVATE_BLOCK_TEXT: Record<ElevateBlock, string> = {
  elevate_ssh_only: "Administrator rights during a session are for SSH resources (a Linux server) and remote desktops of a Windows server.",
  elevate_needs_native: "Turn on Native SSH client for this resource first: the rights are given to a session in the user's own SSH app.",
  elevate_needs_recording: "A user's own SSH or Remote Desktop app is not recorded here, and Captivo cannot give rights to a session it does not carry: turn on session recording for this resource (or require it in the Policy), or turn the native client off.",
  elevate_needs_account: "Add the administrator account first: root or an account that can use sudo on Linux, the built-in Administrator on Windows.",
  elevate_root: "The resource's account must be an ordinary user: on Linux lower case letters, digits, _ and -, and not root; on Windows not the built-in Administrator.",
  elevate_windows_local: "Only a local account of the Windows server can be given administrator rights this way, not a domain account.",
};

export function elevationPlatform(protocol: string | null | undefined): ElevatePlatform | null {
  const p = String(protocol ?? "").toUpperCase();
  return p === "SSH" ? "linux" : p === "RDP" ? "windows" : null;
}

const LINUX_ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;

/** What stops the rights being given to this resource, or null. */
export function elevationProblem(o: {
  protocol: string | null | undefined; nativeSsh: boolean; nativeRdp?: boolean; recorded: boolean;
  account: string | null | undefined; username: string; windowsLocal?: boolean;
}): ElevateBlock | null {
  const platform = elevationPlatform(o.protocol);
  if (!platform) return "elevate_ssh_only";
  // A user's own app that Captivo does not carry (unrecorded) signs in itself: no session to give rights to.
  if (platform === "linux" && o.nativeSsh && !o.recorded) return "elevate_needs_recording";
  if (platform === "windows" && o.nativeRdp && !o.recorded) return "elevate_needs_recording";
  if (platform === "windows") {
    if (o.windowsLocal === false) return "elevate_windows_local";
    const name = o.username.trim().replace(/^.*\\/, "").toLowerCase();
    if (!name || name === "administrator") return "elevate_root";
  } else if (!LINUX_ACCOUNT.test(o.username) || o.username === "root") return "elevate_root";
  if (!o.account) return "elevate_needs_account";
  return null;
}

type Member = { version: string | null; vaultPublicKey: string | null };
export type ElevationPlan<M extends Member> =
  | { on: false }
  | { on: true; ok: true; carriers: M[]; elevate: { platform: ElevatePlatform; username: string; kind: string }; sealOf: (m: M) => string | undefined }
  | { on: true; ok: false; error: "elevate_reenter" | "connector_outdated" };

/**
 * Whether a session on this resource carries administrator rights, and which
 * of the connectors that may carry it can give them: new enough, and holding
 * its own seal of the administrator account. `native` is the recorded native
 * SSH path, which older connectors (2.71.0) already give them on.
 */
export function elevationPlan<M extends Member>(
  cred: { elevate: boolean; protocol: string; reconcileUsername: string | null; reconcileKind: string | null; reconcileSeals: unknown } | null | undefined,
  members: M[],
  path: "native-ssh" | "session",
): ElevationPlan<M> {
  if (!cred?.elevate) return { on: false };
  const platform = elevationPlatform(cred.protocol);
  if (!platform || !cred.reconcileUsername) return { on: true, ok: false, error: "elevate_reenter" };
  const min = path === "native-ssh" && platform === "linux" ? ELEVATE_MIN_CONNECTOR : ELEVATE_SESSIONS_MIN_CONNECTOR;
  const seals = cred.reconcileSeals && typeof cred.reconcileSeals === "object" && !Array.isArray(cred.reconcileSeals) ? (cred.reconcileSeals as Record<string, string>) : {};
  const capable = members.filter((m) => compareSemver(m.version, min) !== -1);
  if (capable.length === 0) return { on: true, ok: false, error: "connector_outdated" };
  const carriers = capable.filter((m) => !!m.vaultPublicKey && !!seals[m.vaultPublicKey]);
  if (carriers.length === 0) return { on: true, ok: false, error: "elevate_reenter" };
  return { on: true, ok: true, carriers, elevate: { platform, username: cred.reconcileUsername, kind: cred.reconcileKind === "KEY" ? "KEY" : "PASSWORD" }, sealOf: (m) => seals[m.vaultPublicKey!] };
}
