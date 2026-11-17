import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { verifyChain, type StoredEvent } from "@/lib/audit/verify";
import { chainKey, recordVerification } from "@/lib/audit/chain-key";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

const PAGE = 1000;

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Snapshot the chain head first so a concurrent ingest appending newer
  // events while we page can't cause a false head-mismatch: bound the page
  // query to seq <= head.lastSeq.
  const head = await db.auditChainState.findUnique({
    where: chainKey("access"),
    select: { lastSeq: true, lastHash: true },
  });

  // Page through all events in seq order, bounding memory but building the full
  // ordered array the pure verifier expects.
  const events: StoredEvent[] = [];
  let cursorSeq: bigint | null = null;
  for (;;) {
    const where: Prisma.AuditEventWhereInput = head
      ? { seq: { lte: head.lastSeq, ...(cursorSeq === null ? {} : { gt: cursorSeq }) } }
      : cursorSeq === null ? {} : { seq: { gt: cursorSeq } };
    const batch = await db.auditEvent.findMany({
      where,
      orderBy: { seq: "asc" },
      take: PAGE,
      select: {
        seq: true, timestamp: true, userId: true, siteId: true, host: true,
        method: true, path: true, status: true, bytesOut: true, decision: true,
        reason: true, clientIp: true, userAgent: true, prevHash: true, hash: true,
      },
    });
    if (batch.length === 0) break;
    for (const b of batch) events.push(b as StoredEvent);
    cursorSeq = batch[batch.length - 1].seq;
    if (batch.length < PAGE) break;
  }

  const result = verifyChain(events, head ? { lastSeq: head.lastSeq, lastHash: head.lastHash } : undefined);
  await recordVerification("access", result.ok);
  return NextResponse.json(result);
});
