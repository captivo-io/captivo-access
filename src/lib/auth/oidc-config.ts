import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { encrypt, decrypt } from "@/lib/crypto";
import { readPlatformOidc, pickOidcSource } from "./oidc-source";


export type OidcConfigView = {
  /** True when this is Captivo ID rather than the tenant's own provider. */
  isPlatform: boolean;
  enabled: boolean;
  issuer: string;
  clientId: string;
  buttonLabel: string | null;
  hasSecret: boolean;
  lastVerifiedAt: Date | null;
  lastVerifiedOk: boolean | null;
  lastVerifiedDetail: string | null;
};

export async function getOidcConfig(): Promise<OidcConfigView | null> {
  let c;
  try {
    c = await db.oidcConfig.findUnique({ where: { tenantId: currentTenantId() } });
  } catch {
    // If the table doesn't exist yet (deployed before db push) or the DB is
    // unavailable, treat SSO as unconfigured so passkey login still works.
    return null;
  }

  // The tenant's own provider wins; everyone else gets Captivo ID. See
  // oidc-source.ts for why a DISABLED tenant row does not fall back.
  const source = pickOidcSource(
    c ? { enabled: c.enabled, issuer: c.issuer, clientId: c.clientId, hasSecret: c.clientSecret.length > 0 } : null,
    readPlatformOidc(process.env),
  );
  if (source.kind === "none") return null;
  if (source.kind === "platform") {
    return {
      isPlatform: true,
      enabled: true,
      issuer: source.config.issuer,
      clientId: source.config.clientId,
      // English, like the rest of this product. Captivo Access is
      // deliberately single-language (no i18n); a hardcoded Turkish label here
      // was the only Turkish string in the console.
      buttonLabel: "Sign in with Captivo",
      hasSecret: true,
      lastVerifiedAt: null,
      lastVerifiedOk: null,
      lastVerifiedDetail: null,
    };
  }
  if (!c) return null;
  return {
    isPlatform: false,
    enabled: c.enabled,
    issuer: c.issuer,
    clientId: c.clientId,
    buttonLabel: c.buttonLabel,
    hasSecret: c.clientSecret.length > 0,
    lastVerifiedAt: c.lastVerifiedAt,
    lastVerifiedOk: c.lastVerifiedOk,
    lastVerifiedDetail: c.lastVerifiedDetail,
  };
}

export async function getOidcSecret(): Promise<string | null> {
  const c = await db.oidcConfig.findUnique({
    where: { tenantId: currentTenantId() },
    select: { clientSecret: true, enabled: true, issuer: true, clientId: true },
  });
  // Same precedence as getOidcConfig -- the two MUST agree, or a login starts
  // against one provider and exchanges its code against the other's secret.
  const source = pickOidcSource(
    c ? { enabled: c.enabled, issuer: c.issuer, clientId: c.clientId, hasSecret: c.clientSecret.length > 0 } : null,
    readPlatformOidc(process.env),
  );
  if (source.kind === "platform") return source.config.clientSecret;
  if (source.kind === "none") return null;
  if (!c || !c.clientSecret) return null;
  return decrypt(c.clientSecret);
}

export async function saveOidcConfig(input: {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  buttonLabel?: string | null;
}): Promise<void> {
  const issuer = input.issuer.trim();
  const clientId = input.clientId.trim();
  const buttonLabel = input.buttonLabel?.trim() || null;
  const secretProvided = typeof input.clientSecret === "string" && input.clientSecret.length > 0;
  const encSecret = secretProvided ? encrypt(input.clientSecret!.trim()) : undefined;

  await db.oidcConfig.upsert({
    where: { tenantId: currentTenantId() },
    create: { tenantId: currentTenantId(), enabled: input.enabled, issuer, clientId, clientSecret: encSecret ?? "", buttonLabel },
    update: {
      enabled: input.enabled,
      issuer,
      clientId,
      buttonLabel,
      ...(encSecret !== undefined ? { clientSecret: encSecret } : {}),
    },
  });
}
