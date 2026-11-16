export type SecretInput =
  | { secret: string } // plaintext: sealed here if the connector has a key, else encrypted
  | { sealedSecret: string; sealedTo: string }; // sealed in the browser

// Parse the secret fields of an admin request: a browser-sealed value, or a
// plaintext one (API clients, connectors without a key). Empty = none given.
export function secretInputFrom(b: Record<string, unknown>): SecretInput | null {
  if (typeof b.sealedSecret === "string" && b.sealedSecret) {
    return { sealedSecret: b.sealedSecret, sealedTo: typeof b.sealedTo === "string" ? b.sealedTo : "" };
  }
  if (typeof b.secret === "string" && b.secret) return { secret: b.secret };
  return null;
}
