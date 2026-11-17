import { db } from "@/lib/db";
import { buildAuditWhere } from "./filter";

export type AuditFilter = {
  q?: string;
  userId?: string;
  siteId?: string;
  decision?: "ALLOW" | "DENY";
  kind?: "file";
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
};

export type AuditRow = {
  id: string;
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
  // BigInt is not JSON/CSV serializable — always exposed as a string.
  bytesOut: string;
  decision: "ALLOW" | "DENY";
  reason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  // The chain position, for the page's event drawer (BigInt exposed as a string).
  seq: string;
  prevHash: string;
  hash: string;
};

export async function listAuditEvents(filter: AuditFilter): Promise<{ rows: AuditRow[]; total: number }> {
  const where = buildAuditWhere(filter);

  const [events, total] = await Promise.all([
    db.auditEvent.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: filter.limit,
      skip: filter.offset,
      select: {
        id: true,
        timestamp: true,
        userId: true,
        userEmail: true,
        userName: true,
        company: true,
        siteId: true,
        siteName: true,
        host: true,
        method: true,
        path: true,
        status: true,
        bytesOut: true,
        decision: true,
        reason: true,
        clientIp: true,
        userAgent: true,
        seq: true,
        prevHash: true,
        hash: true,
      },
    }),
    db.auditEvent.count({ where }),
  ]);

  const rows: AuditRow[] = events.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    userId: e.userId,
    userEmail: e.userEmail,
    userName: e.userName,
    company: e.company,
    siteId: e.siteId,
    siteName: e.siteName,
    host: e.host,
    method: e.method,
    path: e.path,
    status: e.status,
    bytesOut: String(e.bytesOut),
    decision: e.decision,
    reason: e.reason,
    clientIp: e.clientIp,
    userAgent: e.userAgent,
    seq: String(e.seq),
    prevHash: e.prevHash,
    hash: e.hash,
  }));

  return { rows, total };
}

const CSV_HEADER = [
  "timestamp",
  "userName",
  "userEmail",
  "company",
  "siteName",
  "host",
  "method",
  "path",
  "status",
  "decision",
  "reason",
  "clientIp",
  "bytesOut",
];

export function csvEscape(value: string): string {
  // Formula-injection guard: fields like userAgent/path can carry
  // attacker-influenced content. If the value starts with a character a
  // spreadsheet (Excel/Sheets) interprets as a formula prefix (= + - @) or
  // a tab/CR, prepend a single quote so it opens as plain text instead of
  // being evaluated as a formula.
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(value);
  const escaped = needsFormulaGuard ? `'${value}` : value;
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

export function toCsv(rows: AuditRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    const fields = [
      row.timestamp.toISOString(),
      row.userName ?? "",
      row.userEmail ?? "",
      row.company ?? "",
      row.siteName ?? "",
      row.host,
      row.method,
      row.path,
      String(row.status),
      row.decision,
      row.reason ?? "",
      row.clientIp ?? "",
      row.bytesOut,
    ];
    lines.push(fields.map(csvEscape).join(","));
  }
  return lines.join("\r\n");
}
