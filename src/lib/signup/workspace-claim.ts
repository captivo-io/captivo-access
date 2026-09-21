import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What the slug-confirmation step is allowed to believe.
 *
 * Signed because that step creates a workspace for whichever organisation it
 * is handed. An unsigned value would let anyone who can reach the page name an
 * organisation they have no grant for.
 *
 * Short-lived on purpose: this is a handoff between two requests of the same
 * sign-in, not a session.
 */
export interface WorkspaceClaim {
  org: string;
  orgName: string;
  email: string;
  name?: string;
  exp: number;
}

const TTL_MS = 15 * 60 * 1000;

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signWorkspaceClaim(claim: Omit<WorkspaceClaim, "exp">, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...claim, exp: now + TTL_MS })).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

export function readWorkspaceClaim(token: string | undefined, secret: string, now = Date.now()): WorkspaceClaim | null {
  if (!token || !secret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(payload, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as WorkspaceClaim;
    if (typeof claim.exp !== "number" || claim.exp <= now) return null;
    if (!claim.org || !claim.orgName || !claim.email) return null;
    return claim;
  } catch {
    return null;
  }
}
