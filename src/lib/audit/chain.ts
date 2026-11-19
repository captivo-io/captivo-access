import { createHash } from "node:crypto";

// Fields that are part of the attested record, in FROZEN order. `id` and
// `createdAt` are DB-local bookkeeping and are intentionally excluded.
export type ChainableEvent = {
  seq: bigint;
  timestamp: Date;
  userId: string | null;
  siteId: string | null;
  host: string;
  method: string;
  path: string;
  status: number;
  bytesOut: bigint;
  decision: string;
  reason: string | null;
  clientIp: string | null;
  userAgent: string | null;
};

// Unit separator — a byte that never appears in the field values, so the
// concatenation is unambiguous.
const US = "\x1f";

export const GENESIS_PREV_HASH = "";

// Fixed, application-chosen 64-bit seed for the access chain's advisory lock;
// lockChain (chain-key.ts) hashes it with the tenant id, so each tenant's chain
// has its own lock. The exact value is arbitrary.
export const AUDIT_CHAIN_LOCK_KEY = 6011971385529861010n;

export function canonicalize(e: ChainableEvent): string {
  return [
    e.seq.toString(),
    e.timestamp.toISOString(),
    e.userId ?? "",
    e.siteId ?? "",
    e.host,
    e.method,
    e.path,
    String(e.status),
    e.bytesOut.toString(),
    e.decision,
    e.reason ?? "",
    e.clientIp ?? "",
    e.userAgent ?? "",
  ].join(US);
}

export function chainHash(prevHash: string, canonical: string): string {
  return createHash("sha256").update(prevHash + "\n" + canonical).digest("hex");
}

export function computeHash(prevHash: string, e: ChainableEvent): string {
  return chainHash(prevHash, canonicalize(e));
}
