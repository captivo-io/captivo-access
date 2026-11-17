import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { verifyAdminChain, type AdminStored } from "@/lib/audit/admin-chain";
import { chainKey, recordVerification } from "@/lib/audit/chain-key";
import { withTenantRoute } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Snapshot the head first, then bound the row query to seq <= head.lastSeq so
  // a concurrent admin append can't cause a false head-mismatch.
  const head = await db.auditChainState.findUnique({
    where: chainKey("admin"),
    select: { lastSeq: true, lastHash: true },
  });

  const rows = await db.adminAuditEvent.findMany({
    where: head ? { seq: { not: null, lte: head.lastSeq } } : { seq: { not: null } },
    orderBy: { seq: "asc" },
    select: { seq: true, timestamp: true, actorId: true, actorEmail: true, action: true, targetType: true, targetId: true, summary: true, metadata: true, clientIp: true, prevHash: true, hash: true },
  });

  const events: AdminStored[] = rows.map((r) => ({
    seq: r.seq as bigint, timestamp: r.timestamp, actorId: r.actorId, actorEmail: r.actorEmail,
    action: r.action, targetType: r.targetType, targetId: r.targetId, summary: r.summary,
    metadata: r.metadata ?? null, clientIp: r.clientIp, prevHash: r.prevHash, hash: r.hash,
  }));

  const result = verifyAdminChain(events, head ?? undefined);
  await recordVerification("admin", result.ok);
  return NextResponse.json(result);
});
