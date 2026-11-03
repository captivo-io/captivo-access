import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Captivo ID sign-in for the Captivo Admin app, without making the app an OIDC
 * client of its own (Portal's app sign-in works the same way).
 *
 * The app opens /api/mobile/auth/start on the workspace's own host in the
 * system browser, with a PKCE challenge. Access runs the console's ordinary
 * Captivo ID sign-in -- so the workspace's second-step rule, SSO-only switch,
 * centre role sync and membership checks all apply unchanged -- and at the end
 * hands the browser back to the app with a one-time code bound to that
 * challenge. The app trades code + verifier for its bearer token.
 *
 * No secret ships in the app and Captivo ID needs no new client or redirect URI.
 */

/** The only place the browser is ever sent back to. Exact, like every redirect URI. */
export const APP_REDIRECT = "captivo://auth/access";

export const HANDOFF_COOKIE = "ca_mobile_handoff";
export const HANDOFF_PATH = "/api/mobile/auth";
export const HANDOFF_TTL_SEC = 10 * 60;

/** RFC 7636 S256 challenge: 32 bytes of SHA-256, base64url without padding. */
export function isPkceChallenge(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
}

export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const got = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required");
  return s;
}

function mac(payload: string): string {
  // Domain-separated so this MAC can never be replayed as another signed value.
  return createHmac("sha256", secret()).update(`mobile-handoff:${payload}`).digest("base64url");
}

/** The hand-off cookie: the app's challenge and when it stops being good. */
export function signHandoff(challenge: string, now = Date.now()): string {
  const payload = `${challenge}.${Math.floor(now / 1000) + HANDOFF_TTL_SEC}`;
  return `${payload}.${mac(payload)}`;
}

export function readHandoff(value: string | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [challenge, exp, sig] = parts;
  const want = Buffer.from(mac(`${challenge}.${exp}`));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  return isPkceChallenge(challenge) ? challenge : null;
}

export function appRedirect(params: Record<string, string>): string {
  return `${APP_REDIRECT}?${new URLSearchParams(params).toString()}`;
}
