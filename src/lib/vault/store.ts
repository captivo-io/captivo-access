import { Prisma } from "@/generated/prisma/client";
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

export type StoredSecret = { secret: string; sealedTo: string | null; extraSeals?: Record<string, string> | null };

export class VaultInputError extends Error {}

/**
 * What a resource's secret is sealed for: its connector, or every member of its
 * connector group. A group resource keeps one seal per member key (the first in
 * `secret`/`sealedTo`, the others in `extraSeals`), so whichever member carries
 * the session opens its own copy.
 */
export type VaultHolder = { connectorId: string; connectorGroupId?: string | null };

type KeyedConnector = { status: string; vaultPublicKey: string | null };

function keysOf(connector: KeyedConnector | null | undefined, group: { members: { connector: KeyedConnector }[] } | null | undefined): { keys: string[]; complete: boolean } {
  const live = group ? group.members.map((m) => m.connector).filter((c) => c.status !== "REVOKED") : connector ? [connector] : [];
  const keys = [...new Set(live.map((c) => c.vaultPublicKey).filter((k): k is string => !!k))];
  return { keys, complete: live.length > 0 && keys.length === live.length };
}

const keyedSelect = { select: { status: true, vaultPublicKey: true } } as const;

async function holderKeys(h: VaultHolder): Promise<{ keys: string[]; complete: boolean }> {
  if (h.connectorGroupId) {
    const g = await db.connectorGroup.findUnique({ where: { id: h.connectorGroupId }, select: { members: { orderBy: { createdAt: "asc" }, select: { connector: keyedSelect } } } });
    return keysOf(null, g);
  }
  const c = await db.connector.findUnique({ where: { id: h.connectorId }, select: { status: true, vaultPublicKey: true } });
  return keysOf(c, null);
}

const asHolder = (h: string | VaultHolder): VaultHolder => (typeof h === "string" ? { connectorId: h } : h);

/** Every seal a stored secret carries, by the key it was sealed to. */
export function sealsOf(c: { secret: string; sealedTo: string | null; extraSeals?: unknown }): Record<string, string> {
  const out: Record<string, string> = {};
  if (c.extraSeals && typeof c.extraSeals === "object" && !Array.isArray(c.extraSeals)) {
    for (const [k, v] of Object.entries(c.extraSeals as Record<string, unknown>)) if (typeof v === "string" && isSealed(v)) out[k] = v;
  }
  if (c.sealedTo && isSealed(c.secret)) out[c.sealedTo] = c.secret;
  return out;
}

export function splitSeals(seals: Record<string, string>, order: string[]): StoredSecret {
  const keys = [...new Set(order)].filter((k) => seals[k]);
  const [first, ...rest] = keys;
  return { secret: seals[first], sealedTo: first, extraSeals: rest.length ? Object.fromEntries(rest.map((k) => [k, seals[k]])) : null };
}

/** A StoredSecret as VaultCredential columns. */
export function storedSecretColumns(s: StoredSecret) {
  return { secret: s.secret, sealedTo: s.sealedTo, extraSeals: (s.extraSeals ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull };
}

// The value to store for a new secret aimed at target through holder.
export async function storedSecretFor(holder: string | VaultHolder, input: SecretInput, target: VaultTarget): Promise<StoredSecret> {
  const { keys } = await holderKeys(asHolder(holder));
  if ("sealedSecret" in input) {
    if (!isSealedValue(input.sealedSecret)) throw new VaultInputError("invalid_sealed_secret");
    // Sealed to another key (the connector re-keyed, or another connector was
    // picked) it could never open: ask for it again rather than store it.
    if (!keys.includes(input.sealedTo)) throw new VaultInputError("vault_key_changed");
    const seals: Record<string, string> = { [input.sealedTo]: input.sealedSecret };
    for (const [k, v] of Object.entries(input.extraSeals ?? {})) {
      if (!keys.includes(k)) continue; // not (or no longer) a member: useless here
      if (!isSealedValue(v)) throw new VaultInputError("invalid_sealed_secret");
      seals[k] = v;
    }
    return splitSeals(seals, [input.sealedTo, ...keys]);
  }
  if (keys.length) {
    const seals: Record<string, string> = {};
    for (const k of keys) seals[k] = await sealSecret(k, input.secret, target);
    return splitSeals(seals, keys);
  }
  return { secret: encrypt(input.secret), sealedTo: null, extraSeals: null };
}

// A sealed secret opens only for the target and connector it was sealed for.
// Keeping it across a change of either would leave a resource that silently
// cannot sign in, so such a change needs the secret again. For a connector
// group it is enough that one member can still open it; the console names the
// members that cannot.
export async function keptSecretStillOpens(siteId: string, holder: string | VaultHolder, target: VaultTarget): Promise<boolean> {
  const c = await db.vaultCredential.findUnique({ where: { siteId }, select: { targetHost: true, targetPort: true, username: true, sealedTo: true, secret: true, extraSeals: true } });
  if (!c || !c.sealedTo) return true; // legacy: re-sealed for the new target below
  if (c.targetHost !== target.host.trim() || c.targetPort !== target.port || c.username !== target.username.trim()) return false;
  const seals = sealsOf(c);
  return (await holderKeys(asHolder(holder))).keys.some((k) => !!seals[k]);
}

export type VaultInput = {
  siteId: string;
  connectorId: string;
  connectorGroupId?: string | null;
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
  const stored = await storedSecretFor({ connectorId: input.connectorId, connectorGroupId: input.connectorGroupId }, input.secret, target);
  const data = {
    protocol: input.protocol,
    targetHost: input.targetHost.trim(),
    targetPort: input.targetPort,
    username: input.username.trim(),
    ...storedSecretColumns(stored),
    secretKind: input.secretKind,
    guacParams: parseGuacParams(input.guacParams ?? {}) as Prisma.InputJsonValue,
  };
  await db.vaultCredential.upsert({
    where: { siteId: input.siteId },
    create: { siteId: input.siteId, ...data },
    update: data,
  });
}

const holderSelect = {
  connector: keyedSelect,
  connectorGroup: { select: { members: { orderBy: { createdAt: "asc" as const }, select: { connector: keyedSelect } } } },
} as const;

// Server-only. A sealed secret comes back as-is (only a connector opens it),
// with every member's seal for a group resource; `stale` = no connector that
// serves the resource can open it any more, so it must be entered again. A
// legacy one is decrypted, for connectors that cannot open seals.
export async function getVaultCredential(siteId: string) {
  const c = await db.vaultCredential.findUnique({ where: { siteId }, include: { site: { select: holderSelect } } });
  if (!c) return null;
  const sealed = !!c.sealedTo && isSealed(c.secret);
  const seals = sealed ? sealsOf(c) : {};
  const { keys } = keysOf(c.site.connector, c.site.connectorGroup);
  return {
    protocol: c.protocol,
    targetHost: c.targetHost,
    targetPort: c.targetPort,
    username: c.username,
    secret: sealed ? null : decrypt(c.secret),
    sealedSecret: sealed ? c.secret : null,
    seals,
    stale: sealed && !keys.some((k) => !!seals[k]),
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
    select: { protocol: true, targetHost: true, targetPort: true, username: true, guacParams: true, sealedTo: true, secret: true, extraSeals: true, site: { select: holderSelect } },
  });
  if (!c) return null;
  const { sealedTo, secret, extraSeals, site, ...rest } = c;
  const seals = sealsOf({ secret, sealedTo, extraSeals });
  const { keys } = keysOf(site.connector, site.connectorGroup);
  // sealedKeys: which connector keys hold a copy (the form names group members without one).
  return { ...rest, hasSecret: true as const, sealed: !!sealedTo, stale: !!sealedTo && !keys.some((k) => !!seals[k]), sealedKeys: Object.keys(seals) };
}

export async function clearVaultCredential(siteId: string): Promise<void> {
  await db.vaultCredential.deleteMany({ where: { siteId } });
}

// Seal every legacy secret of the connector's resources (its own, and those of
// the groups it is in) to the keys of the connectors that serve them, so the
// cloud stops holding anything it can open. A group resource waits until
// every member has a key: sealed earlier, a member without one could never
// open it. Called when a connector reports its key and after a resource is
// saved. Returns how many were sealed.
export async function sealLegacyCredentials(where: { connectorId: string } | { siteId: string }): Promise<number> {
  const rows = await db.vaultCredential.findMany({
    where: {
      sealedTo: null,
      ...("siteId" in where
        ? { siteId: where.siteId }
        : { site: { OR: [{ connectorId: where.connectorId, connectorGroupId: null }, { connectorGroup: { members: { some: { connectorId: where.connectorId } } } }] } }),
    },
    select: { id: true, secret: true, targetHost: true, targetPort: true, username: true, site: { select: { connectorGroupId: true, ...holderSelect } } },
  });
  let n = 0;
  for (const r of rows) {
    const { keys, complete } = keysOf(r.site.connectorGroupId ? null : r.site.connector, r.site.connectorGroupId ? r.site.connectorGroup : null);
    if (!complete) continue;
    let plain: string;
    try {
      plain = decrypt(r.secret);
    } catch {
      continue; // unreadable: left for the admin to re-enter
    }
    const target = { host: r.targetHost, port: r.targetPort, username: r.username };
    const seals: Record<string, string> = {};
    for (const k of keys) seals[k] = await sealSecret(k, plain, target);
    const stored = splitSeals(seals, keys);
    const res = await db.vaultCredential.updateMany({
      where: { id: r.id, sealedTo: null, secret: r.secret },
      data: storedSecretColumns(stored),
    });
    n += res.count;
  }
  return n;
}
