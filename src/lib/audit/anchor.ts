import { tenantFetch } from "@/lib/net/guarded-fetch";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { buildTimeStampRequest, parseTimeStampResponse } from "./rfc3161";
import { chainKey, type ChainScope } from "@/lib/audit/chain-key";
import {
  resolvedExternalAnchorEnabled,
  resolvedAnchorTsaUrl,
  resolvedAnchorTsaAuth,
} from "@/lib/settings/platform";

// The preimage that gets timestamped: the chain position bound to its hash. Both
// the request (which timestamps sha256(preimage)) and verification (which needs
// the preimage to check the token's imprint) derive from this one definition.
export function anchorPreimage(anchoredSeq: bigint, anchoredHash: string): Buffer {
  return Buffer.from(`${anchoredSeq}:${anchoredHash}`, "utf8");
}

export function anchorDigest(anchoredSeq: bigint, anchoredHash: string): Buffer {
  return createHash("sha256").update(anchorPreimage(anchoredSeq, anchoredHash)).digest();
}

export function shouldAnchor(
  head: { lastSeq: bigint; lastHash: string },
  last: { anchoredSeq: bigint; anchoredHash: string } | null,
): boolean {
  if (head.lastSeq <= 0n) return false;
  if (!last) return true;
  return last.anchoredSeq !== head.lastSeq || last.anchoredHash !== head.lastHash;
}

export type AnchorRunResult =
  | { status: "disabled" }
  | { status: "skipped" }
  | { status: "anchored"; anchoredSeq: string; genTime: string }
  | { status: "failed"; error: string };

// A chain-specific binding for the shared anchoring runner: which chain-state
// singleton to read the head from, and where its anchors are stored.
type AnchorTarget = {
  scope: ChainScope; // which tamper-evidence chain's head to anchor
  findLastAnchor: () => Promise<{ anchoredSeq: bigint; anchoredHash: string } | null>;
  // Positional args so each binding writes the Prisma `create` object literal
  // inline (Prisma's XOR create-input type rejects a non-literal object).
  createAnchor: (
    anchoredSeq: bigint,
    anchoredHash: string,
    tsaUrl: string,
    token: Uint8Array<ArrayBuffer>,
    genTime: Date,
  ) => Promise<unknown>;
};

// runAnchorFor is fail-open: it returns a result object and never throws, so the
// cron handler always responds 200 and the next run retries.
async function runAnchorFor(target: AnchorTarget): Promise<AnchorRunResult> {
  try {
    if (!(await resolvedExternalAnchorEnabled())) return { status: "disabled" };
    const tsaUrl = await resolvedAnchorTsaUrl();
    if (tsaUrl === "") return { status: "disabled" };

    const head = await db.auditChainState.findUnique({
      where: chainKey(target.scope),
      select: { lastSeq: true, lastHash: true },
    });
    if (!head) return { status: "skipped" };

    const last = await target.findLastAnchor();
    if (!shouldAnchor(head, last)) return { status: "skipped" };

    const digest = anchorDigest(head.lastSeq, head.lastHash);
    const req = buildTimeStampRequest(digest);

    const auth = await resolvedAnchorTsaAuth();
    const headers: Record<string, string> = { "Content-Type": "application/timestamp-query" };
    if (auth) headers.Authorization = "Basic " + Buffer.from(auth).toString("base64");

    // The TSA is the workspace's choice: guarded on Cloud (lib/net/guarded-fetch).
    const res = await tenantFetch(tsaUrl, { method: "POST", headers, body: new Uint8Array(req), timeoutMs: 15_000 });
    if (!res.ok) return { status: "failed", error: `TSA HTTP ${res.status}` };
    const der = Buffer.from(await res.arrayBuffer());

    const { token, genTime } = parseTimeStampResponse(der);
    // Prisma's Bytes wants a Uint8Array over a plain ArrayBuffer; a Node Buffer's
    // backing buffer is ArrayBufferLike, so copy into a fresh Uint8Array.
    await target.createAnchor(head.lastSeq, head.lastHash, tsaUrl, new Uint8Array(token), genTime);
    return { status: "anchored", anchoredSeq: head.lastSeq.toString(), genTime: genTime.toISOString() };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : "unknown" };
  }
}

// Anchors the access (proxy) audit chain. Behavior-identical to before the
// runAnchorFor extraction.
export async function runAnchor(): Promise<AnchorRunResult> {
  return runAnchorFor({
    scope: "access",
    findLastAnchor: () =>
      db.auditAnchor.findFirst({ orderBy: { anchoredSeq: "desc" }, select: { anchoredSeq: true, anchoredHash: true } }),
    createAnchor: (anchoredSeq, anchoredHash, tsaUrl, token, genTime) =>
      db.auditAnchor.create({ data: { anchoredSeq, anchoredHash, tsaUrl, token, genTime } }),
  });
}

// Anchors the admin-audit chain (head under "admin-singleton").
export async function runAdminAnchor(): Promise<AnchorRunResult> {
  return runAnchorFor({
    scope: "admin",
    findLastAnchor: () =>
      db.adminAuditAnchor.findFirst({ orderBy: { anchoredSeq: "desc" }, select: { anchoredSeq: true, anchoredHash: true } }),
    createAnchor: (anchoredSeq, anchoredHash, tsaUrl, token, genTime) =>
      db.adminAuditAnchor.create({ data: { anchoredSeq, anchoredHash, tsaUrl, token, genTime } }),
  });
}
