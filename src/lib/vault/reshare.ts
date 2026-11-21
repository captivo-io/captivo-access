import { db } from "@/lib/db";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { compareSemver } from "@/lib/updates/semver";
import { isSealedValue } from "@/lib/vault/seal";
import { sealsOf, splitSeals, storedSecretColumns } from "@/lib/vault/store";
import { recordAdminAction, type AdminActor } from "@/lib/audit/admin";
import { recordConnectorEvent } from "@/lib/connector/history";

// A connector group resource's secret is sealed in the browser to the members
// of that time. A connector that joins later (or re-keys after losing its
// /data) has no copy, so a member that can open the secret copies it: it opens
// it with its own key and seals it again to the newcomer's key, for the same
// target (connector/vaultreseal.go). The cloud only ever moves sealed copies.
//
// Three phases, because the copying is a network call through a tunnel and the
// tenant scope is a transaction: plan (DB), copy (network), save (DB).

/** The first connector release that copies secrets for its group. */
export const VAULT_RESHARE_MIN_CONNECTOR = "2.44.0";

type MemberRef = { id: string; name: string };

export type ReshareItem = {
  credentialId: string;
  siteId: string;
  siteName: string;
  /** The stored columns the plan was made from; saving is conditional on them. */
  secret: string;
  sealedTo: string;
  seals: Record<string, string>;
  target: { host: string; port: number; username: string };
  /** Recipient key → the member it belongs to. */
  to: Record<string, MemberRef>;
};

export type ResharePlan = { source: MemberRef; sourceKey: string; items: ReshareItem[] }[];

/** True when this connector release can copy secrets to its group. */
export function canReshare(c: { status: string; version: string | null }): boolean {
  return c.status === "ONLINE" && !!c.version && compareSemver(c.version, VAULT_RESHARE_MIN_CONNECTOR) !== -1;
}

type Member = { connector: { id: string; name: string; status: string; version: string | null; vaultPublicKey: string | null } };

/**
 * Which members lack a copy, and which member (online, new enough, holding a
 * copy) gives it to them. The members' keys come from their own reports; a
 * revoked member gets nothing.
 */
export function planFor(c: { id: string; secret: string; sealedTo: string | null; extraSeals: unknown; site: { id: string; name: string; members: Member[] }; target: ReshareItem["target"] }):
  { source: MemberRef; sourceKey: string; item: ReshareItem } | null {
  if (!c.sealedTo) return null; // legacy: sealLegacyCredentials seals it for everyone
  const seals = sealsOf(c);
  const live = c.site.members.map((m) => m.connector).filter((m) => m.status !== "REVOKED" && m.vaultPublicKey);
  const to: Record<string, MemberRef> = {};
  for (const m of live) if (!seals[m.vaultPublicKey!] && !to[m.vaultPublicKey!]) to[m.vaultPublicKey!] = { id: m.id, name: m.name };
  if (Object.keys(to).length === 0) return null;
  const source = [...live].sort((a, b) => a.id.localeCompare(b.id)).find((m) => seals[m.vaultPublicKey!] && canReshare(m));
  if (!source) return null;
  return {
    source: { id: source.id, name: source.name },
    sourceKey: source.vaultPublicKey!,
    item: { credentialId: c.id, siteId: c.site.id, siteName: c.site.name, secret: c.secret, sealedTo: c.sealedTo, seals, target: c.target, to },
  };
}

const memberSelect = { select: { connector: { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } } } } as const;

/** Phase 1 (scoped): the group resources whose secret some member cannot open yet. */
export async function planGroupReshare(where: { groupIds?: string[] } = {}): Promise<ResharePlan> {
  const rows = await db.vaultCredential.findMany({
    where: { sealedTo: { not: null }, site: { connectorGroupId: where.groupIds ? { in: where.groupIds } : { not: null } } },
    select: {
      id: true, secret: true, sealedTo: true, extraSeals: true, targetHost: true, targetPort: true, username: true,
      site: { select: { id: true, name: true, connectorGroup: { select: { members: memberSelect } } } },
    },
  });
  const bySource = new Map<string, ResharePlan[number]>();
  for (const r of rows) {
    const p = planFor({
      ...r,
      site: { id: r.site.id, name: r.site.name, members: r.site.connectorGroup?.members ?? [] },
      target: { host: r.targetHost, port: r.targetPort, username: r.username },
    });
    if (!p) continue;
    const batch = bySource.get(p.source.id) ?? { source: p.source, sourceKey: p.sourceKey, items: [] };
    batch.items.push(p.item);
    bySource.set(p.source.id, batch);
  }
  return [...bySource.values()];
}

export type ReshareResult = Map<string, Record<string, string>>; // credentialId → recipient key → seal

/** Above dataplane Reseal's 20 s stream deadline. */
const RESHARE_TIMEOUT_MS = 25_000;
const BATCH = 500;

/** Phase 2 (unscoped): each source member copies its batch. Failures leave the item for the next pass. */
export async function runGroupReshare(plan: ResharePlan): Promise<ReshareResult> {
  const out: ReshareResult = new Map();
  const base = (process.env.DATAPLANE_URL || "http://access-dataplane:3102").replace(/\/+$/, "");
  for (const batch of plan) {
    for (let i = 0; i < batch.items.length; i += BATCH) {
      const items = batch.items.slice(i, i + BATCH);
      const res = await fetchWithTimeout(`${base}/vault-reseal`, {
        timeoutMs: RESHARE_TIMEOUT_MS,
        method: "POST",
        headers: { "content-type": "application/json", "x-dataplane-secret": process.env.DATAPLANE_SECRET ?? "" },
        body: JSON.stringify({
          connectorId: batch.source.id,
          items: items.map((it) => ({ id: it.credentialId, sealed: it.seals[batch.sourceKey], host: it.target.host, port: String(it.target.port), username: it.target.username, to: Object.keys(it.to) })),
        }),
      }).catch(() => null);
      if (!res?.ok) {
        console.warn(`vault: ${batch.source.id} could not copy secrets (${res ? res.status : "dataplane unreachable"})`);
        continue;
      }
      const data = (await res.json().catch(() => null)) as { items?: { id?: unknown; seals?: unknown }[] } | null;
      const asked = new Map(items.map((it) => [it.credentialId, it]));
      for (const r of data?.items ?? []) {
        const it = typeof r.id === "string" ? asked.get(r.id) : undefined;
        if (!it || !r.seals || typeof r.seals !== "object") continue;
        // Only what was asked for, in the sealed format: never a key it chose itself.
        const seals: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.seals as Record<string, unknown>)) if (it.to[k] && isSealedValue(v)) seals[k] = v as string;
        if (Object.keys(seals).length) out.set(it.credentialId, seals);
      }
    }
  }
  return out;
}

/** Phase 3 (scoped): store the copies, record who gave what to whom. Returns how many resources got copies. */
export async function saveGroupReshare(plan: ResharePlan, result: ReshareResult, actor: AdminActor | null): Promise<number> {
  let n = 0;
  const given = new Map<string, { from: MemberRef; to: MemberRef; sites: string[] }>();
  for (const batch of plan) {
    for (const it of batch.items) {
      const fresh = result.get(it.credentialId);
      if (!fresh) continue;
      const merged = { ...it.seals, ...fresh };
      // Conditional on the secret being the one copied: re-entered meanwhile, the copy is stale.
      const res = await db.vaultCredential.updateMany({
        where: { id: it.credentialId, secret: it.secret, sealedTo: it.sealedTo },
        data: storedSecretColumns(splitSeals(merged, [it.sealedTo, ...Object.keys(merged)])),
      });
      if (res.count === 0) continue;
      n++;
      for (const k of Object.keys(fresh)) {
        const to = it.to[k];
        const key = `${batch.source.id}\0${to.id}`;
        const g = given.get(key) ?? { from: batch.source, to, sites: [] };
        g.sites.push(it.siteId);
        given.set(key, g);
      }
    }
  }
  for (const g of given.values()) {
    const what = `the saved password${g.sites.length === 1 ? "" : "s"} of ${g.sites.length} resource${g.sites.length === 1 ? "" : "s"}`;
    await recordAdminAction({
      actor: actor ?? { id: "system", email: null },
      action: "connector.vault_reshare",
      targetType: "connector", targetId: g.to.id,
      summary: `${g.from.name} copied ${what} to ${g.to.name}`,
      metadata: { fromConnectorId: g.from.id, toConnectorId: g.to.id, siteIds: g.sites.slice(0, 100), count: g.sites.length },
    });
    await recordConnectorEvent(g.to.id, "info", `Received ${what} from ${g.from.name}`);
  }
  return n;
}

/** All three phases in the caller's scope, for a request that has just changed a group. */
export async function reshareGroupSecrets(where: { groupIds?: string[] }, actor: AdminActor | null): Promise<number> {
  const plan = await planGroupReshare(where);
  if (plan.length === 0) return 0;
  return saveGroupReshare(plan, await runGroupReshare(plan), actor);
}
