import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import type { VaultProtocol, VaultSecretKind } from "@/generated/prisma/enums";
import { parseGuacParams, type GuacParams } from "@/lib/gateway/guac-params";
import { isSealed, isSealedValue, sealSecret, type VaultTarget } from "@/lib/vault/seal";
import type { SecretInput } from "@/lib/vault/secret-input";

export { secretInputFrom, type SecretInput } from "@/lib/vault/secret-input";

// A resource secret is SEALED to its connector's vault key (src/lib/vault/seal.ts):
// the admin's browser seals it, the cloud stores and forwards what it cannot
// open, and only the connector opens it. A connector that has not reported a
// key yet (not updated) gets the earlier server-side encryption, which is
// sealed as soon as it reports one (sealLegacyCredentials).

export type StoredSecret = { secret: string; sealedTo: string | null };

export class VaultInputError extends Error {}

async function connectorKey(connectorId: string): Promise<string | null> {
  const c = await db.connector.findUnique({ where: { id: connectorId }, select: { vaultPublicKey: true } });
  return c?.vaultPublicKey ?? null;
}

// The value to store for a new secret aimed at target via connectorId.
export async function storedSecretFor(connectorId: string, input: SecretInput, target: VaultTarget): Promise<StoredSecret> {
  const key = await connectorKey(connectorId);
  if ("sealedSecret" in input) {
    if (!isSealedValue(input.sealedSecret)) throw new VaultInputError("invalid_sealed_secret");
    // Sealed to another key (the connector re-keyed, or another connector was
    // picked) it could never open: ask for it again rather than store it.
    if (!key || input.sealedTo !== key) throw new VaultInputError("vault_key_changed");
    return { secret: input.sealedSecret, sealedTo: key };
  }
  if (key) return { secret: await sealSecret(key, input.secret, target), sealedTo: key };
  return { secret: encrypt(input.secret), sealedTo: null };
}

// A sealed secret opens only for the target and connector it was sealed for.
// Keeping it across a change of either would leave a resource that silently
// cannot sign in, so such a change needs the secret again.
export async function keptSecretStillOpens(siteId: string, connectorId: string, target: VaultTarget): Promise<boolean> {
  const c = await db.vaultCredential.findUnique({ where: { siteId }, select: { targetHost: true, targetPort: true, username: true, sealedTo: true } });
  if (!c || !c.sealedTo) return true; // legacy: re-sealed for the new target below
  if (c.sealedTo !== (await connectorKey(connectorId))) return false;
  return c.targetHost === target.host.trim() && c.targetPort === target.port && c.username === target.username.trim();
}

export type VaultInput = {
  siteId: string;
  connectorId: string;
  protocol: VaultProtocol;
  targetHost: string;
  targetPort: number;
  username: string;
  secret: SecretInput;
  secretKind: VaultSecretKind;
  guacParams?: GuacParams;
};

export async function setVaultCredential(input: VaultInput): Promise<void> {
  const target = { host: input.targetHost, port: input.targetPort, username: input.username };
  const stored = await storedSecretFor(input.connectorId, input.secret, target);
  const data = {
    protocol: input.protocol,
    targetHost: input.targetHost.trim(),
    targetPort: input.targetPort,
    username: input.username.trim(),
    secret: stored.secret,
    sealedTo: stored.sealedTo,
    secretKind: input.secretKind,
    guacParams: parseGuacParams(input.guacParams ?? {}) as Prisma.InputJsonValue,
  };
  await db.vaultCredential.upsert({
    where: { siteId: input.siteId },
    create: { siteId: input.siteId, ...data },
    update: data,
  });
}

// Server-only. A sealed secret comes back as-is (only the connector opens it);
// `stale` = sealed to a key its connector no longer has, so it must be entered
// again. A legacy one is decrypted, for connectors that cannot open seals.
export async function getVaultCredential(siteId: string) {
  const c = await db.vaultCredential.findUnique({ where: { siteId }, include: { site: { select: { connector: { select: { vaultPublicKey: true } } } } } });
  if (!c) return null;
  const sealed = !!c.sealedTo && isSealed(c.secret);
  return {
    protocol: c.protocol,
    targetHost: c.targetHost,
    targetPort: c.targetPort,
    username: c.username,
    secret: sealed ? null : decrypt(c.secret),
    sealedSecret: sealed ? c.secret : null,
    stale: sealed && c.sealedTo !== c.site.connector?.vaultPublicKey,
    secretKind: c.secretKind,
    guacParams: c.guacParams,
  };
}

export async function hasVaultCredential(siteId: string): Promise<boolean> {
  return (await db.vaultCredential.count({ where: { siteId } })) > 0;
}

// Non-secret fields for seeding the site form (the secret is never returned).
export async function getVaultCredentialMeta(siteId: string) {
  const c = await db.vaultCredential.findUnique({
    where: { siteId },
    select: { protocol: true, targetHost: true, targetPort: true, username: true, guacParams: true, sealedTo: true, site: { select: { connector: { select: { vaultPublicKey: true } } } } },
  });
  if (!c) return null;
  const { sealedTo, site, ...rest } = c;
  return { ...rest, hasSecret: true as const, sealed: !!sealedTo, stale: !!sealedTo && sealedTo !== site.connector?.vaultPublicKey };
}

export async function clearVaultCredential(siteId: string): Promise<void> {
  await db.vaultCredential.deleteMany({ where: { siteId } });
}

// Seal every legacy secret of the connector's resources to its key, so the
// cloud stops holding anything it can open. Called when the connector reports
// its key and after a resource is saved. Returns how many were sealed.
export async function sealLegacyCredentials(where: { connectorId: string } | { siteId: string }): Promise<number> {
  const rows = await db.vaultCredential.findMany({
    where: { sealedTo: null, ...("siteId" in where ? { siteId: where.siteId } : { site: { connectorId: where.connectorId } }) },
    select: { id: true, secret: true, targetHost: true, targetPort: true, username: true, site: { select: { connector: { select: { vaultPublicKey: true } } } } },
  });
  let n = 0;
  for (const r of rows) {
    const key = r.site.connector?.vaultPublicKey;
    if (!key) continue;
    let plain: string;
    try {
      plain = decrypt(r.secret);
    } catch {
      continue; // unreadable: left for the admin to re-enter
    }
    const sealed = await sealSecret(key, plain, { host: r.targetHost, port: r.targetPort, username: r.username });
    const res = await db.vaultCredential.updateMany({ where: { id: r.id, sealedTo: null, secret: r.secret }, data: { secret: sealed, sealedTo: key } });
    n += res.count;
  }
  return n;
}
