import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { isSealedValue } from "@/lib/vault/seal";
import { canRotate } from "@/lib/vault/rotation";
import { recordAdminAction } from "@/lib/audit/admin";
import { recordConnectorEvent } from "@/lib/connector/history";

// The reconcile accounts of password rotation, copied to connectors that came
// later -- the same copying as reshare.ts does for resource passwords, with
// the reconcile seal's own additional data ("reconcile,..."). A connector's
// copy of a Linux resource's reconcile account goes to the resource's other
// connectors; the directory's reset account goes to every connector.

type Ref = { id: string; name: string };
type Connector = Ref & { status: string; version: string | null; vaultPublicKey: string | null };

export type ReconcileCopy = {
  owner: { kind: "site"; credentialId: string; siteName: string; username: string } | { kind: "directory"; username: string };
  host: string;
  port: number;
  username: string;
  seals: Record<string, string>;
  source: Ref;
  sourceKey: string;
  to: Record<string, Ref>;
};

function sealMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (isSealedValue(s)) out[k] = s;
  return out;
}

/** Who lacks a copy, and who (online, on a rotating release, holding one) gives it. */
export function planCopy(seals: Record<string, string>, holders: Connector[]): { source: Ref; sourceKey: string; to: Record<string, Ref> } | null {
  const live = holders.filter((c) => c.status !== "REVOKED" && c.vaultPublicKey);
  const to: Record<string, Ref> = {};
  for (const c of live) if (!seals[c.vaultPublicKey!]) to[c.vaultPublicKey!] = { id: c.id, name: c.name };
  if (Object.keys(to).length === 0) return null;
  const source = [...live].sort((a, b) => a.id.localeCompare(b.id)).find((c) => seals[c.vaultPublicKey!] && canRotate(c));
  if (!source) return null;
  return { source: { id: source.id, name: source.name }, sourceKey: source.vaultPublicKey!, to };
}

const conn = { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } } as const;

/** Phase 1 (scoped). */
export async function planReconcileCopies(): Promise<ReconcileCopy[]> {
  const out: ReconcileCopy[] = [];
  const creds = await db.vaultCredential.findMany({
    where: { reconcileUsername: { not: null }, site: { connectorGroupId: { not: null } } },
    select: { id: true, targetHost: true, targetPort: true, reconcileUsername: true, reconcileSeals: true, site: { select: { name: true, connectorGroup: { select: { members: { select: { connector: conn } } } } } } },
  });
  for (const c of creds) {
    const seals = sealMap(c.reconcileSeals);
    const p = planCopy(seals, c.site.connectorGroup?.members.map((m) => m.connector) ?? []);
    if (p) out.push({ owner: { kind: "site", credentialId: c.id, siteName: c.site.name, username: c.reconcileUsername! }, host: c.targetHost, port: c.targetPort, username: c.reconcileUsername!, seals, ...p });
  }
  const dir = await db.directoryConfig.findFirst({ where: { resetUsername: { not: "" } }, select: { host: true, port: true, resetUsername: true, resetSeals: true } });
  if (dir?.resetSeals) {
    const seals = sealMap(dir.resetSeals);
    const p = planCopy(seals, await db.connector.findMany(conn));
    if (p) out.push({ owner: { kind: "directory", username: dir.resetUsername }, host: dir.host, port: dir.port, username: dir.resetUsername, seals, ...p });
  }
  return out;
}

/** Phase 2 (unscoped). Index in the plan → recipient key → seal. */
export async function runReconcileCopies(plan: ReconcileCopy[]): Promise<Map<number, Record<string, string>>> {
  const out = new Map<number, Record<string, string>>();
  const base = (process.env.DATAPLANE_URL || "http://access-dataplane:3102").replace(/\/+$/, "");
  for (const [i, c] of plan.entries()) {
    const res = await fetchWithTimeout(`${base}/vault-reseal`, {
      timeoutMs: 25_000,
      method: "POST",
      headers: { "content-type": "application/json", "x-dataplane-secret": process.env.DATAPLANE_SECRET ?? "" },
      body: JSON.stringify({ connectorId: c.source.id, items: [{ id: String(i), sealed: c.seals[c.sourceKey], host: c.host, port: String(c.port), username: c.username, to: Object.keys(c.to), purpose: "reconcile" }] }),
    }).catch(() => null);
    if (!res?.ok) continue;
    const data = (await res.json().catch(() => null)) as { items?: { id?: unknown; seals?: unknown }[] } | null;
    const r = data?.items?.find((x) => x.id === String(i));
    if (!r?.seals || typeof r.seals !== "object") continue;
    const seals: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.seals as Record<string, unknown>)) if (c.to[k] && isSealedValue(v)) seals[k] = v;
    if (Object.keys(seals).length) out.set(i, seals);
  }
  return out;
}

/** Phase 3 (scoped): merge into what is stored now, if it is still the same account. */
export async function saveReconcileCopies(plan: ReconcileCopy[], got: Map<number, Record<string, string>>): Promise<number> {
  let n = 0;
  for (const [i, fresh] of got) {
    const c = plan[i];
    if (c.owner.kind === "site") {
      const row = await db.vaultCredential.findFirst({ where: { id: c.owner.credentialId, reconcileUsername: c.username, targetHost: c.host, targetPort: c.port }, select: { reconcileSeals: true } });
      if (!row) continue;
      await db.vaultCredential.update({ where: { id: c.owner.credentialId }, data: { reconcileSeals: { ...sealMap(row.reconcileSeals), ...fresh } as Prisma.InputJsonValue } });
    } else {
      const row = await db.directoryConfig.findFirst({ where: { resetUsername: c.username, host: c.host, port: c.port }, select: { tenantId: true, resetSeals: true } });
      if (!row) continue;
      await db.directoryConfig.update({ where: { tenantId: row.tenantId }, data: { resetSeals: { ...sealMap(row.resetSeals), ...fresh } as Prisma.InputJsonValue } });
    }
    n++;
    const what = c.owner.kind === "site" ? `the reconcile account (${c.username}) of ${c.owner.siteName}` : `the directory's password reset account (${c.username})`;
    for (const k of Object.keys(fresh)) {
      const to = c.to[k];
      await recordAdminAction({
        actor: { id: "system", email: null }, action: "connector.vault_reshare", targetType: "connector", targetId: to.id,
        summary: `${c.source.name} copied ${what} to ${to.name}`,
        metadata: { fromConnectorId: c.source.id, toConnectorId: to.id, purpose: "reconcile" },
      });
      await recordConnectorEvent(to.id, "info", `Received ${what} from ${c.source.name}`);
    }
  }
  return n;
}
