// Administrator rights for the length of a session (zero standing privilege):
// an SSH resource's account is an ordinary user, and while someone has a
// recorded session on it the connector gives it sudo through an entry in
// /etc/sudoers.d, removed when the last session ends (connector/elevate.go).
// The resource's reconcile account (root, or one with sudo) does the writing.

/** Connectors that give and take away the entry. */
export const ELEVATE_MIN_CONNECTOR = "2.71.0";

export type ElevateBlock = "elevate_ssh_only" | "elevate_needs_native" | "elevate_needs_recording" | "elevate_needs_account" | "elevate_root";

export const ELEVATE_BLOCK_TEXT: Record<ElevateBlock, string> = {
  elevate_ssh_only: "Administrator rights during a session are for SSH resources.",
  elevate_needs_native: "Turn on Native SSH client for this resource first: the rights are given to a session in the user's own SSH app.",
  elevate_needs_recording: "Turn on session recording for this resource (or require it in the Policy) first: the rights are given to recorded sessions only.",
  elevate_needs_account: "Add the administrator account (root, or one that can use sudo) first.",
  elevate_root: "The resource's account must be an ordinary user in lower case letters, digits, _ and -, not root.",
};

const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;

/** What stops the rights being given to this resource, or null. */
export function elevationProblem(o: { protocol: string | null | undefined; nativeSsh: boolean; recorded: boolean; account: string | null | undefined; username: string }): ElevateBlock | null {
  if (String(o.protocol ?? "").toUpperCase() !== "SSH") return "elevate_ssh_only";
  if (!o.nativeSsh) return "elevate_needs_native";
  if (!o.recorded) return "elevate_needs_recording";
  if (!ACCOUNT.test(o.username) || o.username === "root") return "elevate_root";
  if (!o.account) return "elevate_needs_account";
  return null;
}
