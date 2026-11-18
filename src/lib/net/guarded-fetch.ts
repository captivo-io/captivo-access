import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateAddress } from "./public-url";
import { multiTenantEnabled } from "@/lib/tenant/enabled";

/**
 * Outbound calls to an address a workspace admin typed (their IdP, mail server,
 * TSA, webhook). On Cloud the server must not be steerable at its own network:
 * a tenant admin could otherwise read internal services through the answer (or
 * the error). So on Cloud:
 *   - the host is resolved here, every address is checked, and the connection is
 *     made to the checked address (a DNS answer that changes between the check
 *     and the connect can't slip through);
 *   - redirects are not followed (one could point inside).
 * A self-hosted install may call anything on its own network, so there it is a
 * plain fetch.
 */

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`refused: ${host} is on a private or internal network`);
    this.name = "PrivateAddressError";
  }
}

export function guardActive(): boolean {
  return multiTenantEnabled();
}

/** dns.lookup that refuses private, loopback, link-local and similar answers. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const literal = isIP(hostname);
  if (literal) {
    if (isPrivateAddress(hostname)) return callback(new PrivateAddressError(hostname), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: hostname, family: literal }]);
    return callback(null, hostname, literal);
  }
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, "", 0);
    const list = addrs as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) return callback(new PrivateAddressError(hostname), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/** Resolves a host the guarded way: its first public address, or throws. */
export function resolvePublic(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    guardedLookup(hostname, {}, (err, address) => (err ? reject(err) : resolve(address as string)));
  });
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

type Init = { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams | Uint8Array; timeoutMs: number };

/** A bounded request with the guard applied: a real fetch Response, never following redirects. */
export function guardedRequest(input: string | URL, init: Init): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") return Promise.reject(new Error("unsupported_protocol"));
  const body = init.body === undefined ? undefined : init.body instanceof URLSearchParams ? init.body.toString() : init.body;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body instanceof URLSearchParams && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  // Node skips the lookup for an IP literal, so a literal is checked here.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isPrivateAddress(literal)) return Promise.reject(new PrivateAddressError(literal));
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: init.method ?? "GET", headers, lookup: guardedLookup, timeout: init.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        // Discovery documents, key sets, tokens and timestamps are small.
        if (size > MAX_BODY_BYTES) return req.destroy(new Error("response_too_large"));
        chunks.push(c);
      });
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
          else if (v !== undefined) h.set(k, v);
        }
        const status = res.statusCode ?? 502;
        // Response refuses a body on these statuses.
        const nullBody = status === 204 || status === 205 || status === 304;
        resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage, headers: h }));
      });
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })), init.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The call to make for a tenant-supplied URL: guarded on Cloud, a plain bounded fetch elsewhere. */
export function tenantFetch(input: string | URL, init: Init): Promise<Response> {
  if (guardActive()) return guardedRequest(input, init);
  const { timeoutMs, ...rest } = init;
  return fetch(input, { ...rest, body: rest.body as BodyInit | undefined, signal: AbortSignal.timeout(timeoutMs) });
}
