import type { Prisma } from "@/generated/prisma/client";
import type { AuditFilter } from "./query";
import { TRANSFER_VERBS } from "./access-format";

// Pure + db-free: builds the Prisma `where` and parses query params so the two
// audit routes (list + CSV export) share one definition and unit-test in node.
export function buildAuditWhere(filter: AuditFilter): Prisma.AuditEventWhereInput {
  const where: Prisma.AuditEventWhereInput = {};
  if (filter.userId) where.userId = filter.userId;
  if (filter.siteId) where.siteId = filter.siteId;
  if (filter.decision) where.decision = filter.decision;
  if (filter.kind === "file") where.method = { in: [...TRANSFER_VERBS] };
  if (filter.from || filter.to) {
    where.timestamp = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }
  const q = filter.q?.trim();
  if (q && q.length >= 2) {
    where.OR = [
      { path: { contains: q, mode: "insensitive" } },
      { host: { contains: q, mode: "insensitive" } },
      { userEmail: { contains: q, mode: "insensitive" } },
      { userName: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
      { clientIp: { contains: q } },
    ];
  }
  return where;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseAuditFilter(
  sp: URLSearchParams,
  opts: { defaultLimit: number; maxLimit: number },
): AuditFilter {
  const q = sp.get("q")?.trim() || undefined;
  const userId = sp.get("userId")?.trim() || undefined;
  const siteId = sp.get("siteId")?.trim() || undefined;
  const decisionParam = sp.get("decision");
  const decision = decisionParam === "ALLOW" || decisionParam === "DENY" ? decisionParam : undefined;
  const kind = sp.get("kind") === "file" ? "file" : undefined;
  const from = parseDate(sp.get("from"));
  const to = parseDate(sp.get("to"));
  const limitParam = Number(sp.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), opts.maxLimit) : opts.defaultLimit;
  const offsetParam = Number(sp.get("offset"));
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;
  return { q, userId, siteId, decision, kind, from, to, limit, offset };
}
