export const SECRET_SOURCES = ["hashicorp", "cyberark", "azure", "aws", "sshca"] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];

export type SecretInput = (
  | { secret: string } // plaintext: sealed here if the connector has a key, else encrypted
  // Sealed in the browser: to one connector, or for a connector group to each
  // member (extraSeals holds the members other than sealedTo, by their key).
  | { sealedSecret: string; sealedTo: string; extraSeals?: Record<string, string> }
) & {
  /** Set when the sealed value is a reference to a credential kept in the customer's own vault. */
  source?: SecretSource;
};

// Parse the secret fields of an admin request: a browser-sealed value, or a
// plaintext one (API clients, connectors without a key). Empty = none given.
export function secretInputFrom(b: Record<string, unknown>): SecretInput | null {
  const source = (SECRET_SOURCES as readonly unknown[]).includes(b.secretSource) ? { source: b.secretSource as SecretSource } : {};
  if (typeof b.sealedSecret === "string" && b.sealedSecret) {
    const extra = b.extraSeals && typeof b.extraSeals === "object" && !Array.isArray(b.extraSeals)
      ? Object.fromEntries(Object.entries(b.extraSeals as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string").slice(0, 32))
      : undefined;
    return { sealedSecret: b.sealedSecret, sealedTo: typeof b.sealedTo === "string" ? b.sealedTo : "", ...(extra && Object.keys(extra).length ? { extraSeals: extra } : {}), ...source };
  }
  if (typeof b.secret === "string" && b.secret) return { secret: b.secret, ...source };
  return null;
}
