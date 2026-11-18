// SSO goes on only after its provider passed the connection test. Pure, so the
// route and its tests share it.

const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

export interface SavedSso { enabled: boolean; issuer: string; lastVerifiedOk: boolean | null }

/**
 * "test_required" when this save would switch SSO on without a passed test for
 * the same issuer. Re-saving a provider that is already on with the same issuer
 * stays allowed; changing the issuer needs a new test.
 */
export function enableError(saved: SavedSso | null, next: { enabled: boolean; issuer: string }): "test_required" | null {
  if (!next.enabled) return null;
  if (!saved || norm(saved.issuer) !== norm(next.issuer)) return "test_required";
  if (saved.enabled) return null;
  return saved.lastVerifiedOk === true ? null : "test_required";
}
