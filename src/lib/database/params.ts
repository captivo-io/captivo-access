import { compareSemver } from "@/lib/updates/semver";

// Database resources (accessMode DATABASE): a PostgreSQL server reached with
// the user's own client through the data plane's proxy (dataplane/pgproxy.go).
// The connector signs in with the saved account (connector/dbproxy.go), so it
// must understand the "db" stream.

export const DATABASE_MIN_CONNECTOR = "2.46.0";

/** The proxy's public port when DB_PUBLIC_PORT is not set. */
export const DEFAULT_DB_PORT = 15432;

/** How long a ticket starts connections, at most; never past the grant's end. */
export const DB_TICKET_TTL_MS = 8 * 3600_000;

export const DB_ENGINES = ["POSTGRES"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];
export const DB_TLS_MODES = ["disable", "require", "verify-full"] as const;
export type DbTlsMode = (typeof DB_TLS_MODES)[number];

export type DbParams = {
  /** The database a client lands in when it names none. */
  database: string;
  /** The only databases a client may open; empty = any the account can. */
  databases: string[];
  tls: DbTlsMode;
  caCertPem: string | null;
};

const NAME_RE = /^[^\s\0"]{1,63}$/;

/** A database name PostgreSQL accepts in a startup message (no spaces or quotes, to keep it simple). */
export function validDbName(s: string): boolean {
  return NAME_RE.test(s);
}

/** Reads stored params, falling back to safe defaults for anything missing. */
export function parseDbParams(v: unknown): DbParams {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const database = typeof o.database === "string" && validDbName(o.database) ? o.database : "postgres";
  const databases = Array.isArray(o.databases) ? o.databases.filter((d): d is string => typeof d === "string" && validDbName(d)).slice(0, 50) : [];
  const tls = DB_TLS_MODES.includes(o.tls as DbTlsMode) ? (o.tls as DbTlsMode) : "require";
  const caCertPem = typeof o.caCertPem === "string" && o.caCertPem.includes("BEGIN CERTIFICATE") ? o.caCertPem.trim() : null;
  return { database, databases, tls, caCertPem };
}

/** Validates a form/API body's database fields. */
export function dbParamsFrom(body: Record<string, unknown>): DbParams | { error: string } {
  const database = typeof body.database === "string" ? body.database.trim() : "";
  if (!validDbName(database)) return { error: "invalid_database" };
  const raw = Array.isArray(body.databases) ? body.databases : typeof body.databases === "string" ? body.databases.split(/[\s,]+/) : [];
  const databases = [...new Set(raw.map((d) => (typeof d === "string" ? d.trim() : "")).filter(Boolean))];
  if (databases.length > 50 || databases.some((d) => !validDbName(d))) return { error: "invalid_database" };
  if (databases.length > 0 && !databases.includes(database)) databases.unshift(database);
  const tls = DB_TLS_MODES.includes(body.dbTls as DbTlsMode) ? (body.dbTls as DbTlsMode) : "require";
  const ca = typeof body.caCertPem === "string" ? body.caCertPem.trim() : "";
  if (ca && (!ca.includes("BEGIN CERTIFICATE") || ca.length > 20_000)) return { error: "invalid_ca_cert" };
  return { database, databases, tls, caCertPem: tls === "verify-full" && ca ? ca : null };
}

export type DbBlock = "not_database" | "connector_outdated" | "proxy_off";

/** Why a database resource can't be opened now, or null when it can. */
export function databaseBlock(s: { accessMode: string; connectorVersion: string | null | undefined }): DbBlock | null {
  if (s.accessMode !== "DATABASE") return "not_database";
  if (compareSemver(s.connectorVersion, DATABASE_MIN_CONNECTOR) === -1) return "connector_outdated";
  return null;
}

/** The proxy's public name: DB_PUBLIC_HOST, else the console's own host. */
export function dbPublicHost(consoleHost: string): string {
  return process.env.DB_PUBLIC_HOST?.trim() || consoleHost;
}

export function dbPublicPort(): number {
  const n = Number(process.env.DB_PUBLIC_PORT ?? DEFAULT_DB_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_DB_PORT;
}

/** The psql command line a ticket goes in. */
export function psqlCommand(t: { host: string; port: number; ticket: string; database: string }): string {
  return `psql "host=${t.host} port=${t.port} user=${t.ticket} dbname=${t.database} sslmode=require"`;
}
