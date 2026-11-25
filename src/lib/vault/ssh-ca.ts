import type { VaultCredential } from "@/generated/prisma/client";

// SSH certificate sign-in: a recorded SSH resource with no password or key
// anywhere. The connector keeps a certificate authority key, the server trusts
// its public half, and every session signs in with a certificate that is good
// for two minutes (connector/sshca.go). It is stored like a vault reference
// (secretSource "sshca"), so rotation, check-out and "show password" already
// stay away from it.

/** What stops a resource from signing in with certificates, or null. */
export type SshCaBlock = "ssh_ca_ssh_only" | "ssh_ca_needs_native" | "ssh_ca_needs_recording";

/**
 * Certificates are signed by the connector and used by the connector's own
 * sign-in, which only the recorded native SSH path has: the browser's terminal
 * (guacd) cannot present one, and an unrecorded native session is the user's
 * own sign-in.
 */
export function sshCaProblem(o: { protocol: string | null | undefined; nativeSsh: boolean; recorded: boolean }): SshCaBlock | null {
  if (String(o.protocol ?? "").toUpperCase() !== "SSH") return "ssh_ca_ssh_only";
  if (!o.nativeSsh) return "ssh_ca_needs_native";
  if (!o.recorded) return "ssh_ca_needs_recording";
  return null;
}

export const SSH_CA_BLOCK_TEXT: Record<SshCaBlock, string> = {
  ssh_ca_ssh_only: "Certificate sign-in is only for SSH resources.",
  ssh_ca_needs_native: "Certificate sign-in is used through the user's own SSH client: turn on Native SSH client for this resource.",
  ssh_ca_needs_recording: "Certificate sign-in goes through the recorded native SSH path: turn on session recording for this resource (or require it in the Policy).",
};

export const isSshCa = (c: Pick<VaultCredential, "secretSource"> | { secretSource?: string | null } | null | undefined) => c?.secretSource === "sshca";

/** The lines to put in a server's trusted CA file, one per connector that can sign in. */
export function trustedCaFile(keys: (string | null | undefined)[]): string {
  return [...new Set(keys.filter((k): k is string => !!k))].join("\n");
}

/** The commands that make a server trust the CA (the account name must equal the login). */
export function sshCaServerSetup(keys: (string | null | undefined)[]): string {
  const file = trustedCaFile(keys);
  return `echo '${file.replace(/'/g, "'\\''")}' | sudo tee /etc/ssh/captivo_ca.pub >/dev/null\n`
    + `echo 'TrustedUserCAKeys /etc/ssh/captivo_ca.pub' | sudo tee /etc/ssh/sshd_config.d/captivo-ca.conf >/dev/null\n`
    + `sudo sshd -t && sudo systemctl reload sshd`;
}

/** One `ssh-ed25519 <base64>` line and nothing else (no comment, no line break). */
export function isSshCaKey(v: unknown): v is string {
  return typeof v === "string" && /^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(v);
}
