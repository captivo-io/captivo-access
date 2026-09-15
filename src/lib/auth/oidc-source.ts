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

/**
 * The origin the callback must come back to.
 *
 * FOUND BY ACTUALLY CONNECTING IT. The callback URI was built from the REQUEST
 * host, which is right for a tenant's own provider -- each tenant registers
 * their own console's URL with their own Okta. It is wrong for the platform
 * provider: Access is multi-tenant and every tenant lives on its own
 * subdomain, so the URI changed per tenant while Captivo ID knows exactly one,
 * and the exact-match check rejected it.
 *
 * Widening that check to a wildcard would have "fixed" it and opened the door
 * this whole file exists to keep shut. So the platform flow uses ONE fixed
 * origin instead, and the tenant the person came from is carried in the state
 * cookie's `returnTo` -- which works because COOKIE_DOMAIN spans every console
 * subdomain, so a cookie set on acme.cloud.captivo.io is readable at the
 * platform host.
 */
export function callbackOrigin(
  source: OidcSource,
  requestOrigin: string,
  managerPublicUrl: string | undefined,
): string {
  if (source.kind !== "platform") return requestOrigin;
  const fixed = managerPublicUrl?.trim().replace(/\/+$/, "");
  // Without a configured public URL there is no single origin to use, and
  // falling back to the request host would send the person to an address the
  // provider will refuse -- better to keep the tenant path than to invent one.
  return fixed || requestOrigin;
}
