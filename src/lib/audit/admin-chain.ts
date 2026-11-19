import { chainHash, GENESIS_PREV_HASH } from "./chain";
import type { ChainVerifyResult, ChainHead } from "./verify";

// Distinct 64-bit advisory-lock seed for the admin chain (≠ AUDIT_CHAIN_LOCK_KEY),
// so admin appends serialize on their own lock and never block access appends.
export const ADMIN_AUDIT_CHAIN_LOCK_KEY = 6011971385529861011n;
export const ADMIN_CHAIN_ID = "admin-singleton";

const US = "\x1f";

// Deterministic JSON: keys sorted recursively, so a jsonb column that reorders
// keys on read still hashes identically to what was written.
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

export interface AdminChainable {
  seq: bigint;
  timestamp: Date;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  clientIp: string | null;
}

export type AdminStored = AdminChainable & { prevHash: string; hash: string };

// FROZEN field order. id/createdAt are DB bookkeeping and excluded.
export function canonicalizeAdmin(e: AdminChainable): string {
  return [
    e.seq.toString(),
    e.timestamp.toISOString(),
    e.actorId ?? "",
    e.actorEmail ?? "",
    e.action,
    e.targetType ?? "",
    e.targetId ?? "",
    e.summary,
    stableStringify(e.metadata ?? null),
    e.clientIp ?? "",
  ].join(US);
}

export function computeAdminHash(prevHash: string, e: AdminChainable): string {
  return chainHash(prevHash, canonicalizeAdmin(e));
}

// Mirrors verifyChain (adjacency + hash recompute + tail-truncation via head).
export function verifyAdminChain(events: AdminStored[], expectedHead?: ChainHead): ChainVerifyResult {
  if (events.length === 0) {
    return { ok: true, count: 0, firstSeq: null, lastSeq: null, retentionBoundary: false, brokenAtSeq: null, reason: null };
  }
  const retentionBoundary = events[0].prevHash !== GENESIS_PREV_HASH;
  const firstSeq = events[0].seq.toString();
  const lastSeqStr = events[events.length - 1].seq.toString();
  let prevHash: string | null = null;
  for (const e of events) {
    if (computeAdminHash(e.prevHash, e) !== e.hash) {
      return { ok: false, count: events.length, firstSeq, lastSeq: lastSeqStr, retentionBoundary, brokenAtSeq: e.seq.toString(), reason: "hash_mismatch" };
    }
    if (prevHash !== null && e.prevHash !== prevHash) {
      return { ok: false, count: events.length, firstSeq, lastSeq: lastSeqStr, retentionBoundary, brokenAtSeq: e.seq.toString(), reason: "prev_hash_mismatch" };
    }
    prevHash = e.hash;
  }
  if (expectedHead) {
    const last = events[events.length - 1];
    if (last.seq !== expectedHead.lastSeq || last.hash !== expectedHead.lastHash) {
      return { ok: false, count: events.length, firstSeq, lastSeq: last.seq.toString(), retentionBoundary, brokenAtSeq: last.seq.toString(), reason: "head_mismatch" };
    }
  }
  return { ok: true, count: events.length, firstSeq, lastSeq: lastSeqStr, retentionBoundary, brokenAtSeq: null, reason: null };
}
