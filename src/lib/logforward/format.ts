import type { LogRecord } from "./records";

// How a record is written for each kind of destination. Pure.

export type FormatContext = {
  /** Product version, for CEF's header. */
  version: string;
  /** The workspace console's host name: syslog's HOSTNAME and the cloud kinds' host. */
  hostname: string;
  /** The workspace's short name, as a tag. */
  workspace: string;
};

export const APP_NAME = "captivo-access";

/** The record as a JSON object: the cloud kinds' event, and syslog's message in JSON format. */
export function jsonEvent(r: LogRecord, ctx: FormatContext): Record<string, unknown> {
  const o: Record<string, unknown> = {
    "@timestamp": r.at.toISOString(),
    workspace: ctx.workspace,
    category: r.category,
    action: r.action,
    name: r.name,
    outcome: r.outcome,
    message: r.message,
  };
  if (r.user || r.userName || r.company) o.user = strip({ email: r.user, name: r.userName, company: r.company });
  if (r.resource || r.resourceId) o.resource = strip({ id: r.resourceId, name: r.resource, host: r.host });
  if (r.method && r.category !== "session") o.http = strip({ method: r.method, path: r.path, status: r.status, bytes: r.bytes });
  if (r.clientIp || r.userAgent) o.client = strip({ ip: r.clientIp, userAgent: r.userAgent });
  if (r.reason) o.reason = r.reason;
  if (r.target) o.target = r.target;
  o.log = { source: r.source, seq: r.seq.toString(), hash: r.hash };
  return o;
}

function strip(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

// CEF (ArcSight Common Event Format, rev. 25): a pipe-separated header, then
// key=value extensions. Header fields escape \ and |; extension values escape
// \ and = and carry line breaks as \n.
const cefHeader = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const cefValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r?\n/g, "\\n").replace(/\r/g, "\\r");

export function cefSeverity(r: LogRecord): number {
  if (r.outcome === "deny") return 7;
  if (r.category === "admin") return 5;
  if (r.category === "file") return 4;
  return 3;
}

export function cef(r: LogRecord, ctx: FormatContext): string {
  const ext: [string, string | number | null | undefined][] = [
    ["rt", r.at.getTime()],
    ["act", r.action],
    ["outcome", r.outcome],
    ["suser", r.user],
    ["src", r.clientIp],
    ["dhost", r.category === "admin" ? null : r.host],
    ["requestMethod", r.category === "request" ? r.method : null],
    ["request", r.category === "request" || r.category === "file" ? r.path : null],
    ["requestClientApplication", r.userAgent],
    ["out", r.bytes ? r.bytes : null],
    ["cs1Label", r.resource ? "Resource" : null], ["cs1", r.resource],
    ["cs2Label", r.reason ? "Reason" : null], ["cs2", r.reason],
    ["cs3Label", r.company ? "Company" : null], ["cs3", r.company],
    ["cs4Label", "Workspace"], ["cs4", ctx.workspace],
    ["cs5Label", r.target ? "Target" : null], ["cs5", r.target],
    ["cn1Label", r.status ? "HttpStatus" : null], ["cn1", r.status],
    ["externalId", `${r.source}-${r.seq}`],
    ["msg", r.message],
  ];
  const body = ext
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${cefValue(String(v))}`)
    .join(" ");
  return `CEF:0|Captivo|Access|${cefHeader(ctx.version)}|${cefHeader(r.action)}|${cefHeader(r.name)}|${cefSeverity(r)}|${body}`;
}

/** Syslog severity (RFC 5424): warning for a denial, notice for an admin's action, else informational. */
export function syslogSeverity(r: LogRecord): number {
  if (r.outcome === "deny") return 4;
  if (r.category === "admin") return 5;
  return 6;
}

export const FACILITIES: { code: number; label: string }[] = [
  { code: 4, label: "auth" },
  { code: 10, label: "authpriv" },
  { code: 13, label: "log audit" },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ code: 16 + n, label: `local${n}` })),
];

// RFC 5424 header fields are printable US-ASCII with no spaces.
const headerField = (s: string, max: number) => s.replace(/[^\x21-\x7e]/g, "").slice(0, max) || "-";

/** One RFC 5424 syslog message: <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG. */
export function syslogLine(r: LogRecord, ctx: FormatContext, opts: { format: "cef" | "json"; facility: number }): string {
  const pri = opts.facility * 8 + syslogSeverity(r);
  const msg = opts.format === "json" ? JSON.stringify(jsonEvent(r, ctx)) : cef(r, ctx);
  return `<${pri}>1 ${r.at.toISOString()} ${headerField(ctx.hostname, 255)} ${APP_NAME} - ${headerField(r.category, 32)} - ${msg}`;
}

/** Splunk HTTP Event Collector: one JSON object per event, concatenated. */
export function splunkHecBody(records: LogRecord[], ctx: FormatContext): string {
  return records
    .map((r) => JSON.stringify({
      time: r.at.getTime() / 1000,
      host: ctx.hostname,
      source: APP_NAME,
      sourcetype: "captivo:access",
      event: jsonEvent(r, ctx),
    }))
    .join("\n");
}

/** Datadog Logs intake (v2): a JSON array; message is what the Log Explorer shows. */
export function datadogBody(records: LogRecord[], ctx: FormatContext): string {
  return JSON.stringify(records.map((r) => ({
    ...jsonEvent(r, ctx),
    ddsource: APP_NAME,
    service: APP_NAME,
    hostname: ctx.hostname,
    ddtags: `workspace:${ctx.workspace},category:${r.category},outcome:${r.outcome}`,
    status: r.outcome === "deny" ? "warn" : "info",
  })));
}

/** Any HTTPS endpoint: a JSON array of events. */
export function genericBody(records: LogRecord[], ctx: FormatContext): string {
  return JSON.stringify(records.map((r) => jsonEvent(r, ctx)));
}
