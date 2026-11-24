import { compareSemver } from "@/lib/updates/semver";

// Database resources (accessMode DATABASE): a PostgreSQL, MySQL, SQL Server,
// Redis or MongoDB server reached with the user's own client through the data
// plane's proxy (dataplane/pgproxy.go, mysqlproxy.go, mssqlproxy.go,
// redisproxy.go, mongoproxy.go). The connector signs in with the saved account
// (connector/dbproxy.go, mysql.go, mssql.go, redis.go, mongo.go), so it must
// understand the "db" stream for the engine.

export const DATABASE_MIN_CONNECTOR = "2.46.0";
export const MYSQL_MIN_CONNECTOR = "2.51.0";
export const MSSQL_MIN_CONNECTOR = "2.56.0";
export const REDIS_MIN_CONNECTOR = "2.64.0";
export const MONGODB_MIN_CONNECTOR = "2.64.0";

/** The proxy's public ports when DB_PUBLIC_PORT / MYSQL_PUBLIC_PORT / MSSQL_PUBLIC_PORT / REDIS_PUBLIC_PORT / MONGODB_PUBLIC_PORT are not set. */
export const DEFAULT_DB_PORT = 15432;
export const DEFAULT_MYSQL_PORT = 13306;
export const DEFAULT_MSSQL_PORT = 11433;
export const DEFAULT_REDIS_PORT = 16380;
export const DEFAULT_MONGODB_PORT = 17017;

/** How long a ticket starts connections, at most; never past the grant's end. */
export const DB_TICKET_TTL_MS = 8 * 3600_000;

export const DB_ENGINES = ["POSTGRES", "MYSQL", "MSSQL", "REDIS", "MONGODB"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

/** The engine a stored credential's protocol names; POSTGRES for anything else. */
export function dbEngineOf(protocol: string | null | undefined): DbEngine {
  const p = String(protocol ?? "").toUpperCase();
  return p === "MYSQL" || p === "MSSQL" || p === "REDIS" || p === "MONGODB" ? p : "POSTGRES";
}

/** The data plane's and connector's name for an engine. */
export function dbEngineWire(engine: DbEngine): "postgres" | "mysql" | "mssql" | "redis" | "mongodb" {
  return engine === "MYSQL" ? "mysql" : engine === "MSSQL" ? "mssql" : engine === "REDIS" ? "redis" : engine === "MONGODB" ? "mongodb" : "postgres";
}

/** How an engine is named on screen. */
export function dbEngineLabel(engine: string | null | undefined): string {
  const e = dbEngineOf(engine);
  return e === "MYSQL" ? "MySQL" : e === "MSSQL" ? "SQL Server" : e === "REDIS" ? "Redis" : e === "MONGODB" ? "MongoDB" : "PostgreSQL";
}

/** The connector release that signs in to this engine. */
export function dbMinConnector(engine: DbEngine): string {
  return engine === "MYSQL" ? MYSQL_MIN_CONNECTOR : engine === "MSSQL" ? MSSQL_MIN_CONNECTOR : engine === "REDIS" ? REDIS_MIN_CONNECTOR : engine === "MONGODB" ? MONGODB_MIN_CONNECTOR : DATABASE_MIN_CONNECTOR;
}

/** The server's usual port. */
export function dbDefaultPort(engine: DbEngine): number {
  return engine === "MYSQL" ? 3306 : engine === "MSSQL" ? 1433 : engine === "REDIS" ? 6379 : engine === "MONGODB" ? 27017 : 5432;
}
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
export function parseDbParams(v: unknown, engine: DbEngine = "POSTGRES"): DbParams {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const database = typeof o.database === "string" && validDbName(o.database) ? o.database : engine === "POSTGRES" ? "postgres" : "";
  const databases = Array.isArray(o.databases) ? o.databases.filter((d): d is string => typeof d === "string" && validDbName(d)).slice(0, 50) : [];
  const tls = DB_TLS_MODES.includes(o.tls as DbTlsMode) ? (o.tls as DbTlsMode) : "require";
  const caCertPem = typeof o.caCertPem === "string" && o.caCertPem.includes("BEGIN CERTIFICATE") ? o.caCertPem.trim() : null;
  return { database, databases, tls, caCertPem };
}

/**
 * Validates a form/API body's database fields. MySQL and SQL Server may name no
 * default database (the account's own applies), and take no list of allowed
 * ones: a statement can reach another database by name (db.table, db..table),
 * so only the account's own grants can limit it. For Redis the database is a
 * number (SELECT n); for MongoDB it is the account's authentication database
 * (admin when empty), and a command can name any database the account may use.
 */
export function dbParamsFrom(body: Record<string, unknown>, engine: DbEngine = "POSTGRES"): DbParams | { error: string } {
  const database = typeof body.database === "string" ? body.database.trim() : "";
  if (!validDbName(database) && !(engine !== "POSTGRES" && database === "")) return { error: "invalid_database" };
  if (engine === "REDIS" && database !== "" && !/^\d{1,3}$/.test(database)) return { error: "invalid_database" };
  const raw = engine !== "POSTGRES" ? [] : Array.isArray(body.databases) ? body.databases : typeof body.databases === "string" ? body.databases.split(/[\s,]+/) : [];
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
export function databaseBlock(s: { accessMode: string; connectorVersion: string | null | undefined; engine?: DbEngine }): DbBlock | null {
  if (s.accessMode !== "DATABASE") return "not_database";
  if (compareSemver(s.connectorVersion, dbMinConnector(s.engine ?? "POSTGRES")) === -1) return "connector_outdated";
  return null;
}

/** The proxy's public name: DB_PUBLIC_HOST, else the console's own host. */
export function dbPublicHost(consoleHost: string): string {
  return process.env.DB_PUBLIC_HOST?.trim() || consoleHost;
}

/** The proxy's public port for the engine: DB_PUBLIC_PORT, MYSQL_PUBLIC_PORT, MSSQL_PUBLIC_PORT, REDIS_PUBLIC_PORT, MONGODB_PUBLIC_PORT. */
export function dbPublicPort(engine: DbEngine = "POSTGRES"): number {
  const fallback = engine === "MYSQL" ? DEFAULT_MYSQL_PORT : engine === "MSSQL" ? DEFAULT_MSSQL_PORT : engine === "REDIS" ? DEFAULT_REDIS_PORT : engine === "MONGODB" ? DEFAULT_MONGODB_PORT : DEFAULT_DB_PORT;
  const set = engine === "MYSQL" ? process.env.MYSQL_PUBLIC_PORT : engine === "MSSQL" ? process.env.MSSQL_PUBLIC_PORT : engine === "REDIS" ? process.env.REDIS_PUBLIC_PORT : engine === "MONGODB" ? process.env.MONGODB_PUBLIC_PORT : process.env.DB_PUBLIC_PORT;
  const n = Number(set ?? fallback);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** The psql command line a ticket goes in. */
export function psqlCommand(t: { host: string; port: number; ticket: string; database: string }): string {
  return `psql "host=${t.host} port=${t.port} user=${t.ticket} dbname=${t.database} sslmode=require"`;
}

/** The mysql command line a ticket goes in (MariaDB's client takes --ssl instead). */
export function mysqlCommand(t: { host: string; port: number; ticket: string; database: string }): string {
  return `mysql -h ${t.host} -P ${t.port} -u ${t.ticket} --ssl-mode=REQUIRED${t.database ? ` ${t.database}` : ""}`;
}

/** The sqlcmd command line a ticket goes in (any password: the ticket is what counts). */
export function sqlcmdCommand(t: { host: string; port: number; ticket: string; database: string }): string {
  return `sqlcmd -S tcp:${t.host},${t.port} -U ${t.ticket} -P x${t.database ? ` -d ${t.database}` : ""}`;
}

/** The redis-cli command line a ticket goes in (any password: the ticket is what counts). */
export function redisCliCommand(t: { host: string; port: number; ticket: string }): string {
  return `redis-cli --tls -h ${t.host} -p ${t.port} --user ${t.ticket} --pass x`;
}

/** The mongosh command line a ticket goes in: the ticket is the PLAIN user name, any password. */
export function mongoshCommand(t: { host: string; port: number; ticket: string }): string {
  return `mongosh "${mongoUrl(t)}"`;
}

/** The MongoDB connection string a ticket goes in (authSource=$external, as PLAIN takes it). */
export function mongoUrl(t: { host: string; port: number; ticket: string }): string {
  return `mongodb://${t.ticket}:x@${t.host}:${t.port}/?tls=true&authMechanism=PLAIN&authSource=%24external`;
}

/** A rediss:// URL for application drivers and tools that take one. */
export function redisUrl(t: { host: string; port: number; ticket: string }): string {
  return `rediss://${t.ticket}:x@${t.host}:${t.port}`;
}
