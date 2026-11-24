import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { currentTenantId } from "@/lib/tenant/context";
import { readPlatformOidc } from "@/lib/auth/oidc-source";

// Who signs an invited guest in. Captivo ID wherever it is configured -- an
// outsider has an account there or makes one in a minute, and it is the single
// sign-on this product uses -- even on a workspace that federates its own staff
// with its own provider, which knows nobody from outside. Only a self-hosted
// console, which never talks to Captivo ID, falls back to its own provider.

export interface GuestProvider { issuer: string; clientId: string; clientSecret: string; trusted: boolean }

export async function guestProvider(): Promise<GuestProvider | null> {
  const platform = readPlatformOidc(process.env);
  if (platform) return { ...platform, trusted: true };
  const own = await db.oidcConfig.findUnique({ where: { tenantId: currentTenantId() } }).catch(() => null);
  if (!own?.enabled || !own.clientSecret) return null;
  return { issuer: own.issuer, clientId: own.clientId, clientSecret: decrypt(own.clientSecret), trusted: false };
}

export async function guestProviderAvailable(): Promise<boolean> {
  return (await guestProvider()) !== null;
}
