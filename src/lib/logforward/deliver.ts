import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { tenantFetch, PrivateAddressError } from "@/lib/net/guarded-fetch";
import { datadogBody, genericBody, splunkHecBody, type FormatContext } from "./format";
import type { LogRecord } from "./records";

// Delivery, one batch at a time. A syslog batch goes through the data-plane to
// a connector (connector/logforward.go); a cloud one is a guarded HTTPS call
// from here. Both answer the same way so the pump treats them alike.

export type Delivery = { ok: true; latencyMs: number } | { ok: false; reason: string; detail?: string };

/**
 * The connector gives a batch 20 s (8 s to connect, 12 s to write) and the
 * data-plane waits 22 s for it; a little more here. Under the slow scope's
 * budget, so "Send test" can wait for it inside its request.
 */
const SYSLOG_TIMEOUT_MS = 25_000;
const CLOUD_TIMEOUT_MS = 15_000;

export type SyslogTarget = {
  transport: string; host: string; port: number; framing: string | null; caPem: string | null;
};

const authority = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

export async function deliverSyslog(connectorId: string, t: SyslogTarget, messages: string[]): Promise<Delivery> {
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const started = Date.now();
  const res = await fetchWithTimeout(`${base}/connector-logforward`, {
    timeoutMs: SYSLOG_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": process.env.DATAPLANE_SECRET || "" },
    body: JSON.stringify({
      connectorId,
      transport: t.transport,
      target: authority(t.host, t.port),
      framing: t.framing ?? undefined,
      caPem: t.caPem ?? undefined,
      messages,
    }),
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, reason: "no_answer" };
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; detail?: string; latencyMs?: number };
  if (j.ok) return { ok: true, latencyMs: j.latencyMs ?? Date.now() - started };
  return { ok: false, reason: j.reason ?? "no_answer", detail: j.detail };
}

/** Reasons that say the connector could not take the batch at all, so another may. */
export function tryAnotherConnector(reason: string): boolean {
  return reason === "offline" || reason === "connector_too_old" || reason === "no_answer";
}

export type CloudTarget = { kind: string; url: string; headerName: string | null };

export function cloudRequest(t: CloudTarget, secret: string | null, records: LogRecord[], ctx: FormatContext): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": `CaptivoAccess/${ctx.version}` };
  if (t.kind === "splunk_hec") {
    headers.authorization = `Splunk ${secret ?? ""}`;
    return { headers, body: splunkHecBody(records, ctx) };
  }
  if (t.kind === "datadog") {
    headers["dd-api-key"] = secret ?? "";
    return { headers, body: datadogBody(records, ctx) };
  }
  if (t.headerName && secret) headers[t.headerName.toLowerCase()] = secret;
  return { headers, body: genericBody(records, ctx) };
}

export async function deliverCloud(t: CloudTarget, secret: string | null, records: LogRecord[], ctx: FormatContext): Promise<Delivery> {
  const { headers, body } = cloudRequest(t, secret, records, ctx);
  const started = Date.now();
  try {
    const res = await tenantFetch(t.url, { method: "POST", headers, body, timeoutMs: CLOUD_TIMEOUT_MS });
    if (res.status >= 200 && res.status < 300) return { ok: true, latencyMs: Date.now() - started };
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    return { ok: false, reason: `http_${res.status}`, detail: text || undefined };
  } catch (e) {
    if (e instanceof PrivateAddressError) return { ok: false, reason: "private_address" };
    if (e instanceof Error && e.name === "TimeoutError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "unreachable", detail: e instanceof Error ? e.message.slice(0, 200) : undefined };
  }
}
