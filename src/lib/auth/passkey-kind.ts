/**
 * Whether a passkey is synced across the person's devices (iCloud Keychain,
 * Google Password Manager, 1Password…) or bound to one authenticator (a
 * security key). WebAuthn reports it as the backup-eligible flag, which
 * SimpleWebAuthn names `credentialDeviceType: "multiDevice"`; a backed-up
 * credential is synced even if an authenticator misreports eligibility.
 */
export function passkeySynced(info: { credentialDeviceType?: string; credentialBackedUp?: boolean }): boolean | null {
  if (info.credentialDeviceType === "multiDevice" || info.credentialBackedUp === true) return true;
  if (info.credentialDeviceType === "singleDevice") return false;
  return null;
}

export const PASSKEY_LABEL_MAX = 40;

/** A passkey's new name: trimmed, 1–40 characters, or null when unusable. */
export function passkeyLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= PASSKEY_LABEL_MAX ? s : null;
}
