import type { Prisma } from "@/generated/prisma/client";

export type RecordingType = "web" | "rdp" | "ssh" | "sql";

export interface RecordingFilter {
  q?: string;
  /** Web (web app, isolated browser), RDP (RDP and VNC desktops), SSH (SSH, telnet) or a database's query log. */
  type?: RecordingType;
  /** Only sessions that closed at once (under a second, as measured by the connector). */
  empty?: boolean;
  cmd?: string;
  userId?: string;
  siteId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

const TERMINAL = ["ssh", "telnet"];

/** The Web / RDP / SSH tab a recording falls under. */
export function recordingType(r: { format: string; protocol: string | null }): RecordingType {
  if (r.format === "SQL") return "sql";
  if (r.format !== "GUAC") return "web";
  return r.protocol && TERMINAL.includes(r.protocol.toLowerCase()) ? "ssh" : "rdp";
}

// Pure + db-free so the list route and its tests share one definition. `match`
// is what a free-text search found by name (resources, people), looked up first.
export function buildRecordingWhere(
  filter: RecordingFilter,
  match?: { siteIds: string[]; userIds: string[] },
): Prisma.SessionRecordingWhereInput {
  const where: Prisma.SessionRecordingWhereInput = {};
  const and: Prisma.SessionRecordingWhereInput[] = [];
  if (filter.type === "web") where.format = { in: ["RRWEB", "VIDEO"] };
  if (filter.type === "ssh") { where.format = "GUAC"; where.protocol = { in: TERMINAL }; }
  if (filter.type === "sql") where.format = "SQL";
  if (filter.type === "rdp") {
    where.format = "GUAC";
    and.push({ OR: [{ protocol: null }, { protocol: { notIn: TERMINAL } }] });
  }
  if (filter.empty) where.durationMs = { lt: 1000 };
  if (filter.userId) where.userId = filter.userId;
  if (filter.siteId) where.siteId = filter.siteId;
  if (filter.from || filter.to) {
    where.startedAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }
  const q = filter.q?.trim();
  if (q && q.length >= 2) {
    and.push({ OR: [
      { host: { contains: q, mode: "insensitive" } },
      ...(match?.siteIds.length ? [{ siteId: { in: match.siteIds } }] : []),
      ...(match?.userIds.length ? [{ userId: { in: match.userIds } }] : []),
    ] });
  }
  if (and.length) where.AND = and;
  return where;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseRecordingFilter(
  sp: URLSearchParams,
  opts: { defaultLimit: number; maxLimit: number },
): RecordingFilter {
  const q = sp.get("q")?.trim() || undefined;
  const typeParam = sp.get("type");
  const type = typeParam === "web" || typeParam === "rdp" || typeParam === "ssh" || typeParam === "sql" ? typeParam : undefined;
  const empty = sp.get("empty") === "1" || undefined;
  const cmd = sp.get("cmd")?.trim() || undefined;
  const userId = sp.get("userId")?.trim() || undefined;
  const siteId = sp.get("siteId")?.trim() || undefined;
  const from = parseDate(sp.get("from"));
  const to = parseDate(sp.get("to"));
  const limitParam = Number(sp.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), opts.maxLimit) : opts.defaultLimit;
  const offsetParam = Number(sp.get("offset"));
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;
  return { q, type, empty, cmd, userId, siteId, from, to, limit, offset };
}
