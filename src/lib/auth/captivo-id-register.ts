/**
 * Registers a newly self-service-signed-up Access customer with Captivo ID,
 * the shared identity service, so the same Captivo account later reaches
 * Portal too.
 *
 * This is a BEST-EFFORT side effect of signup, never a precondition for it.
 * By the time completeSignup calls this, the trial tenant already exists and
 * the customer is waiting on their invite link -- an unreachable identity
 * service, or any other failure here, must not take that away from them. See
 * registerWithCaptivoId's callers: the result is always logged and ignored.
 */

import { isSelfHosted } from "@/lib/deployment-mode";

export interface CaptivoIdRegistration {
  email: string;
  organizationName: string;
  name: string;
}

/**
 * POST {issuer}/api/register on the identity service.
 *
 * Never on a customer's own server -- same reasoning as readPlatformOidc:
 * Captivo ID lives on the internet, and a self-hosted install must never
 * depend on it, so this is checked BEFORE any configuration is even read.
 *
 * Configuration is all-or-nothing, mirroring readPlatformOidc: without both
 * CAPTIVO_ID_ISSUER and CAPTIVO_ID_SERVICE_SECRET this does not call out --
 * silently rather than erroring, but loudly in the log, since a signup that
 * quietly never reaches Captivo ID (missing env var, not a real outage) is
 * itself the kind of thing this function must not hide.
 *
 * emailVerified: true is sent because Access verified the address itself, by
 * the confirmation link completeSignup just checked -- a claim only a
 * service-authenticated caller may make, which is why the header carries the
 * shared secret rather than trusting the request body.
 *
 * No password: Access has none to give. The identity created here is
 * passkey-only from Access's side; Captivo ID stores no credential for it.
 */
export async function registerWithCaptivoId(
  input: CaptivoIdRegistration,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (isSelfHosted(env)) return;

  const issuer = env.CAPTIVO_ID_ISSUER?.trim();
  const secret = env.CAPTIVO_ID_SERVICE_SECRET?.trim();
  if (!issuer || !secret) {
    console.warn(
      "[captivo-id-register] skipped: CAPTIVO_ID_ISSUER / CAPTIVO_ID_SERVICE_SECRET not configured",
    );
    return;
  }

  try {
    const res = await fetch(`${issuer}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Captivo-Service": secret },
      body: JSON.stringify({
        email: input.email,
        organizationName: input.organizationName,
        product: "ACCESS",
        name: input.name,
        emailVerified: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return;

    if (res.status === 409) {
      // Not a failure: this email already has a Captivo identity, most likely
      // because they are already a Portal customer. Adding Access to an
      // existing organization is a separate flow that does not exist yet --
      // log it distinctly so it is never mistaken for a bug in this one.
      console.info(`[captivo-id-register] identity already exists for ${input.email}, skipping`);
      return;
    }

    const body = await res.text().catch(() => "");
    console.error(`[captivo-id-register] failed: HTTP ${res.status} ${body}`);
  } catch (e) {
    console.error("[captivo-id-register] failed:", e instanceof Error ? e.message : e);
  }
}
