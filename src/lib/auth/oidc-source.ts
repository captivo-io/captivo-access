/**
 * Which OIDC provider this tenant signs in with.
 *
 * TWO DIFFERENT THINGS SHARE THIS SLOT, and keeping them apart is the point:
 *
 *   - A tenant's OWN provider (their Okta, their Entra). Per-tenant, configured
 *     by them, and the reason OidcConfig exists.
 *   - CAPTIVO ID, the platform's own provider. Not a tenant's anything -- it is
 *     how one Captivo account reaches both products.
 *
 * The tenant's own configuration WINS. A customer who has gone to the trouble
 * of federating with their identity provider must not silently be moved onto
 * ours; their directory is where their joiners and leavers are managed, and
 * quietly bypassing it would be a security regression dressed as a feature.
 *
 * Everyone else falls back to Captivo ID, configured once in the environment
 * rather than copied into every tenant's row -- a secret duplicated per tenant
 * is a secret rotated per tenant.
 */

import { isSelfHosted } from "@/lib/deployment-mode";

export interface PlatformOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface TenantOidc {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
}

export type OidcSource =
  | { kind: "tenant" }
  | { kind: "platform"; config: PlatformOidc }
  | { kind: "none" };

/**
 * Read the platform provider from the environment.
 *
 * All three values or nothing: a half-configured provider produces a sign-in
 * button that fails at the token exchange, after the person has typed their
 * password.
 */
export function readPlatformOidc(env: Record<string, string | undefined>): PlatformOidc | null {
  // Never on a customer's own server. Captivo ID lives on the internet; a
  // self-hosted console that depended on it would be locked out whenever that
  // link was down, and permanently in an air-gapped network. Checked BEFORE the
  // variables, so setting them by accident -- by copying the hosted compose
  // file, say -- still changes nothing.
  if (isSelfHosted(env)) return null;

  const issuer = env.CAPTIVO_ID_ISSUER?.trim();
  const clientId = env.CAPTIVO_ID_CLIENT_ID?.trim();
  const clientSecret = env.CAPTIVO_ID_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret };
}

/**
 * Decide which provider applies.
 *
 * A tenant row that exists but is DISABLED means the tenant turned their own
 * federation off. That is a deliberate act and must not be read as "fall back
 * to Captivo ID" -- it means "no SSO", and the passkey and password paths are
 * what remain.
 */
export function pickOidcSource(tenant: TenantOidc | null, platform: PlatformOidc | null): OidcSource {
  if (tenant) {
    return tenant.enabled ? { kind: "tenant" } : { kind: "none" };
  }
  return platform ? { kind: "platform", config: platform } : { kind: "none" };
}

/*
 * A NOTE ON THE CALLBACK ORIGIN, so the idea is not tried again.
 *
 * The callback returns to the host the sign-in started on -- the tenant's own
 * console. Captivo ID therefore registers one exact redirect URI PER TENANT
 * console, and its list grows as tenants are created.
 *
 * Sending every tenant back to a single fixed console host was tried first, to
 * keep that list at one entry. It completes the OIDC handshake and then breaks
 * the thing that matters: this application resolves the tenant from the
 * REQUEST HOST and enforces isolation with row-level security keyed on it, so
 * the callback ran in the platform tenant's context and could not see the
 * person's own users -- and the session, had one been created, would have been
 * on the wrong host. A growing list of exact URIs is the smaller problem, and
 * it grows where new tenants are already provisioned with DNS and a
 * certificate.
 */
