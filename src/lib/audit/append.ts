import { db } from "@/lib/db";
import { computeHash } from "@/lib/audit/chain";
import { chainKey, lockChain } from "@/lib/audit/chain-key";
import { currentTenantId } from "@/lib/tenant/context";

export interface AuditInput {
  timestamp?: string;
  userId?: string;
  siteId?: string;
  host?: string;
  method?: string;
  path?: string;
  status?: number;
  bytesOut?: number;
  decision?: string;
  reason?: string;
  clientIp?: string;
  userAgent?: string;
}

export interface AuditLookups {
  emailById: Map<string, string | null>;
  userNameById: Map<string, string | null>;
  companyById: Map<string, string | null>;
  siteNameById: Map<string, string | null>;
}

export interface NormalizedAuditRow {
  timestamp: Date;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  company: string | null;
  siteId: string | null;
  siteName: string | null;
  host: string;
  method: string;
  path: string;
  status: number;
  bytesOut: bigint;
  decision: "ALLOW" | "DENY";
  reason: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

// Pure: maps an incoming event to the row shape the chain hashes over. Same
// logic previously inline in /api/internal/audit/log.
export function normalizeAuditInput(e: AuditInput, lookups: AuditLookups): NormalizedAuditRow {
  return {
    timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
    userId: e.userId ?? null,
    userEmail: e.userId ? lookups.emailById.get(e.userId) ?? null : null,
    userName: e.userId ? lookups.userNameById.get(e.userId) ?? null : null,
    company: e.userId ? lookups.companyById.get(e.userId) ?? null : null,
    siteId: e.siteId ?? null,
    siteName: e.siteId ? lookups.siteNameById.get(e.siteId) ?? null : null,
    host: e.host ?? "",
    method: e.method ?? "",
    path: e.path ?? "",
    status: typeof e.status === "number" ? e.status : 0,
    bytesOut: BigInt(typeof e.bytesOut === "number" ? Math.max(0, Math.trunc(e.bytesOut)) : 0),
    decision: e.decision === "DENY" ? "DENY" : "ALLOW",
    reason: e.reason ?? null,
    clientIp: e.clientIp ?? null,
    userAgent: e.userAgent ?? null,
  };
}

// Enriches user/site display names, then appends to the tamper-evident chain
// under an advisory lock so concurrent batches never race the head. Returns the
// number of rows inserted. Behavior-identical to the prior inline implementation.
export async function appendAuditEvents(events: AuditInput[]): Promise<number> {
  if (events.length === 0) return 0;

  const userIds = [...new Set(events.map((e) => e.userId).filter((x): x is string => !!x))];
  const siteIds = [...new Set(events.map((e) => e.siteId).filter((x): x is string => !!x))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true, company: true } })
    : [];
  const sites = siteIds.length
    ? await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } })
    : [];
  const lookups: AuditLookups = {
    emailById: new Map(users.map((u) => [u.id, u.email])),
    userNameById: new Map(users.map((u) => [u.id, u.name])),
    companyById: new Map(users.map((u) => [u.id, u.company])),
    siteNameById: new Map(sites.map((s) => [s.id, s.name])),
  };

  const normalized = events.map((e) => normalizeAuditInput(e, lookups));

  return db.$transaction(async (tx) => {
    await lockChain(tx, "access");
    const head = await tx.auditChainState.upsert({
      where: chainKey("access"),
      create: { tenantId: currentTenantId(), scope: "access" },
      update: {},
      select: { lastSeq: true, lastHash: true },
    });
    let lastSeq = head.lastSeq;
    let lastHash = head.lastHash;
    const rows = normalized.map((n) => {
      const seq = lastSeq + BigInt(1);
      const prevHash = lastHash;
      const hash = computeHash(prevHash, { ...n, seq });
      lastSeq = seq;
      lastHash = hash;
      return { ...n, seq, prevHash, hash };
    });
    await tx.auditEvent.createMany({ data: rows });
    await tx.auditChainState.update({ where: chainKey("access"), data: { lastSeq, lastHash } });
    return rows.length;
  });
}
