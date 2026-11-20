import { FACILITIES } from "./format";

// What an admin may save as a log destination. Pure: the API route validates
// with it and the form shares its lists.

export const MAX_DESTINATIONS = 5;

export const KINDS = ["syslog", "splunk_hec", "datadog", "https"] as const;
export type DestinationKind = (typeof KINDS)[number];

export const TRANSPORTS = ["udp", "tcp", "tls"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const DEFAULT_PORT: Record<Transport, number> = { udp: 514, tcp: 514, tls: 6514 };

export const DATADOG_SITES = [
  { site: "datadoghq.com", label: "US1" },
  { site: "us3.datadoghq.com", label: "US3" },
  { site: "us5.datadoghq.com", label: "US5" },
  { site: "datadoghq.eu", label: "EU1" },
  { site: "ap1.datadoghq.com", label: "AP1" },
  { site: "ddog-gov.com", label: "US1-FED" },
] as const;

export const datadogUrl = (site: string) => `https://http-intake.logs.${site}/api/v2/logs`;

export function datadogSiteOf(url: string | null): string {
  const m = /^https:\/\/http-intake\.logs\.([^/]+)\/api\/v2\/logs$/.exec(url ?? "");
  return m && DATADOG_SITES.some((s) => s.site === m[1]) ? m[1] : DATADOG_SITES[0].site;
}

/** A Splunk address without a path gets the HEC event endpoint. */
export function splunkHecUrl(input: string): string {
  const u = new URL(input);
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/services/collector/event";
  return u.toString();
}

export type DestinationData = {
  name: string;
  enabled: boolean;
  kind: DestinationKind;
  transport: Transport | null;
  host: string | null;
  port: number | null;
  framing: "newline" | "octet" | null;
  format: "cef" | "json";
  facility: number;
  caPem: string | null;
  connectorId: string | null;
  fallbackConnectorId: string | null;
  url: string | null;
  headerName: string | null;
  sendSessions: boolean;
  sendFiles: boolean;
  sendDenied: boolean;
  sendAdmin: boolean;
  sendRequests: boolean;
};

export type ParseResult =
  | { ok: true; data: DestinationData; secret: string | null }
  | { ok: false; error: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
// A name or address, never a URL or a list: no scheme, path, space or port.
const HOST_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[?[0-9a-fA-F:]+\]?$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Validates a destination as the form sends it. `secret` is the new token or
 * key; an empty one keeps the stored secret (the caller decides whether one is
 * required). `cloud` is true on the multi-tenant service, where a cloud
 * destination must be HTTPS.
 */
export function parseDestination(b: Record<string, unknown>, opts: { cloud: boolean }): ParseResult {
  const kind = str(b.kind) as DestinationKind;
  if (!KINDS.includes(kind)) return { ok: false, error: "invalid_kind" };
  const name = str(b.name).slice(0, 80);
  if (!name) return { ok: false, error: "name_required" };
  const secret = typeof b.secret === "string" && b.secret.trim() ? b.secret.trim() : null;
  const data: DestinationData = {
    name, kind,
    enabled: b.enabled !== false,
    transport: null, host: null, port: null, framing: null, format: "json", facility: 16, caPem: null,
    connectorId: null, fallbackConnectorId: null, url: null, headerName: null,
    sendSessions: b.sendSessions !== false,
    sendFiles: b.sendFiles !== false,
    sendDenied: b.sendDenied !== false,
    sendAdmin: b.sendAdmin !== false,
    sendRequests: b.sendRequests === true,
  };
  if (secret && secret.length > 4096) return { ok: false, error: "secret_too_long" };

  if (kind === "syslog") {
    const transport = str(b.transport) as Transport;
    if (!TRANSPORTS.includes(transport)) return { ok: false, error: "invalid_transport" };
    const host = str(b.host).replace(/^\[|\]$/g, "");
    if (!host || host.length > 253 || !HOST_RE.test(host)) return { ok: false, error: "invalid_host" };
    const port = typeof b.port === "number" ? b.port : Number(str(b.port) || DEFAULT_PORT[transport]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "invalid_port" };
    const facility = typeof b.facility === "number" ? b.facility : Number(b.facility ?? 16);
    if (!FACILITIES.some((f) => f.code === facility)) return { ok: false, error: "invalid_facility" };
    const connectorId = str(b.connectorId);
    if (!connectorId) return { ok: false, error: "connector_required" };
    const fallback = str(b.fallbackConnectorId);
    const caPem = transport === "tls" ? str(b.caPem) : "";
    if (caPem && (!caPem.includes("-----BEGIN CERTIFICATE-----") || caPem.length > 64 * 1024)) return { ok: false, error: "invalid_ca" };
    Object.assign(data, {
      transport, host, port, facility, caPem: caPem || null, connectorId,
      fallbackConnectorId: fallback && fallback !== connectorId ? fallback : null,
      framing: transport === "udp" ? null : str(b.framing) === "octet" ? "octet" : "newline",
      format: str(b.format) === "json" ? "json" : "cef",
    });
    return { ok: true, data, secret: null };
  }

  let url: string;
  if (kind === "datadog") {
    const site = str(b.datadogSite) || datadogSiteOf(str(b.url));
    if (!DATADOG_SITES.some((s) => s.site === site)) return { ok: false, error: "invalid_site" };
    url = datadogUrl(site);
  } else {
    let u: URL;
    try {
      u = new URL(str(b.url));
    } catch {
      return { ok: false, error: "invalid_url" };
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && !opts.cloud)) return { ok: false, error: "https_required" };
    if (u.username || u.password) return { ok: false, error: "invalid_url" };
    url = kind === "splunk_hec" ? splunkHecUrl(u.toString()) : u.toString();
  }
  if (url.length > 2048) return { ok: false, error: "invalid_url" };
  data.url = url;
  if (kind === "https") {
    const headerName = str(b.headerName);
    if (headerName && !HEADER_RE.test(headerName)) return { ok: false, error: "invalid_header" };
    data.headerName = headerName || null;
  }
  return { ok: true, data, secret };
}

/** A cloud destination needs its secret; a generic HTTPS one only with a header. */
export function secretRequired(d: Pick<DestinationData, "kind" | "headerName">): boolean {
  return d.kind === "splunk_hec" || d.kind === "datadog" || (d.kind === "https" && !!d.headerName);
}
