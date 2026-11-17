import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ADMIN_CATEGORY_PREFIXES, isAdminCategory, type AdminCategory } from "./admin-actions";

export interface AdminAuditRow {
  id: string;
  seq: bigint | null;
  timestamp: Date;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  clientIp: string | null;
  prevHash: string;
  hash: string;
}

export interface AdminAuditFilter {
  limit: number;
  offset: number;
  action?: string;
  category?: AdminCategory;
  q?: string;
}

// Pure + db-free, like buildAuditWhere: the page, the list route and the CSV
// export share one definition.
export function buildAdminAuditWhere(filter: Omit<AdminAuditFilter, "limit" | "offset">): Prisma.AdminAuditEventWhereInput {
  const and: Prisma.AdminAuditEventWhereInput[] = [];
  if (filter.action) and.push({ action: filter.action });
  if (filter.category) and.push({ OR: ADMIN_CATEGORY_PREFIXES[filter.category].map((p) => ({ action: { startsWith: p } })) });
  const q = filter.q?.trim();
  if (q && q.length >= 2) {
    and.push({ OR: [
      { action: { contains: q, mode: "insensitive" } },
      { summary: { contains: q, mode: "insensitive" } },
      { actorEmail: { contains: q, mode: "insensitive" } },
      { targetType: { contains: q, mode: "insensitive" } },
      { targetId: { contains: q } },
    ] });
  }
  return and.length ? { AND: and } : {};
}

export async function listAdminAuditEvents(filter: AdminAuditFilter): Promise<{ rows: AdminAuditRow[]; total: number }> {
  const where = buildAdminAuditWhere(filter);
  const [rows, total] = await Promise.all([
    db.adminAuditEvent.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip: filter.offset,
      take: filter.limit,
      select: { id: true, seq: true, timestamp: true, actorEmail: true, action: true, targetType: true, targetId: true, summary: true, clientIp: true, prevHash: true, hash: true },
    }),
    db.adminAuditEvent.count({ where }),
  ]);
  return { rows, total };
}

const CSV_HEADER = ["timestamp", "seq", "actorEmail", "action", "targetType", "targetId", "summary", "clientIp"];

export function adminToCsv(rows: AdminAuditRow[], escape: (v: string) => string): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push([
      r.timestamp.toISOString(), r.seq?.toString() ?? "", r.actorEmail ?? "", r.action,
      r.targetType ?? "", r.targetId ?? "", r.summary, r.clientIp ?? "",
    ].map(escape).join(","));
  }
  return lines.join("\r\n");
}

export function parseAdminFilter(sp: URLSearchParams, defaultLimit: number, maxLimit: number): AdminAuditFilter {
  const category = sp.get("category");
  const limit = Number(sp.get("limit"));
  const offset = Number(sp.get("offset"));
  return {
    q: sp.get("q")?.trim() || undefined,
    category: isAdminCategory(category) ? category : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), maxLimit) : defaultLimit,
    offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
  };
}
