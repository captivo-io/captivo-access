/**
 * What a sign-in proved, and whether that is enough.
 *
 * `amr` (RFC 8176, "Authentication Methods References") is the identity
 * provider's own statement of how the person authenticated: `["pwd"]` for a
 * password alone, `["pwd","otp"]` when a one-time code followed it, `["mfa"]`
 * when the provider summarises. Captivo ID stamps it on every ID token since
 * its two-step verification shipped; Entra, Okta and Auth0 stamp theirs.
 * Access records the claim on the session row and reads it in exactly one
 * place -- here -- so the policy page's "require two-step verification" has
 * one definition of "two-step".
 *
 * Everything in this module is pure. The routes supply the claim and the
 * policy; this decides.
 */

/**
 * Methods that are a second factor on their own, or say one was used.
 *
 * `otp` and `mfa` are what Captivo ID and the common providers send. `hwk`,
 * `swk` and `sc` are key- and card-based methods a provider only reports when
 * something was possessed; `fido` is not in the RFC but is what Entra writes
 * for a security key. A value NOT in this list -- `pwd`, `sms`, `kba`, an
 * empty array, a vocabulary we have never seen -- is "not proven". The
 * failure mode of a wrong guess is a locked-out person, which is visible and
 * recoverable; the failure mode of the opposite guess is a bypassed policy,
 * which is neither.
 */
const SECOND_FACTOR = new Set(["otp", "mfa", "hwk", "swk", "sc", "fido"]);

/** Longest RFC value is six characters; a 32-char cap keeps junk out of the row. */
const MAX_METHOD_LENGTH = 32;
const MAX_METHODS = 16;

/**
 * The `amr` claim as a clean list, or an empty one.
 *
 * The token's signature was verified before this runs, so the shape is the
 * provider's honest output -- but a provider that sends a string, an object,
 * or nothing is answered with "no methods stated", never a thrown error: the
 * callback this feeds is the only way into the console.
 */
export function readAmr(claims: { amr?: unknown } | null | undefined): string[] {
  const raw = claims?.amr;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const m = v.trim().toLowerCase();
    if (!m || m.length > MAX_METHOD_LENGTH || out.includes(m)) continue;
    out.push(m);
    if (out.length === MAX_METHODS) break;
  }
  return out;
}

/** Did this sign-in prove a second factor? */
export function hasSecondFactor(amr: readonly string[]): boolean {
  return amr.some((m) => SECOND_FACTOR.has(m));
}

/**
 * What a passkey ceremony proved.
 *
 * A passkey is possession of a key. When the authenticator also verified the
 * person -- PIN, fingerprint, face -- the ceremony was two factors, which is
 * what RFC 8176's `mfa` says. Our passkey options ask for verification as
 * "preferred", not "required", so a roaming key without a PIN produces a
 * sign-in that is possession only, and the policy below is allowed to refuse it.
 */
export function passkeyAmr(userVerified: boolean): string[] {
  return userVerified ? ["passkey", "mfa"] : ["passkey"];
}

export type SecondFactorGate = "allow" | "step_up" | "refuse";

/**
 * Whether a sign-in may proceed under the workspace's policy.
 *
 * `step_up` is the one non-obvious answer. A Captivo ID session opened with a
 * password BEFORE the person enrolled an authenticator still says `["pwd"]`,
 * and a plain redirect back to the provider reuses it -- the person who just
 * turned two-step on would be refused by the very policy they were asked to
 * satisfy, with nothing on screen to explain it. So the first unproven arrival
 * is sent back once with `prompt=login`, which makes the provider authenticate
 * again -- now with the code. `steppedUp` says that already happened, and the
 * second unproven arrival is the real answer: this account has no second factor.
 */
export function secondFactorGate(input: { required: boolean; amr: readonly string[]; steppedUp: boolean }): SecondFactorGate {
  if (!input.required) return "allow";
  if (hasSecondFactor(input.amr)) return "allow";
  return input.steppedUp ? "refuse" : "step_up";
}

/**
 * The sessions page's one-word account of a sign-in.
 *
 * "Two-step" when a second factor is proven, whatever the method; otherwise
 * the single method we know of; a dash for rows that predate the column and
 * for support sessions, which never pass through a sign-in.
 */
export function signInLabel(amr: readonly string[]): string {
  if (hasSecondFactor(amr)) return "Two-step";
  if (amr.includes("passkey")) return "Passkey";
  if (amr.includes("pwd")) return "Password";
  return amr.length ? amr.join(", ") : "—";
}
