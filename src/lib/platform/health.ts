import tls from "node:tls";
import { consoleDomain } from "@/lib/tenant/console-domain";
// Shared and BOUNDED -- see lib/site/verify-domain.ts.
import { resolve4 } from "@/lib/site/verify-domain";

// Self-contained provisioning checks for a tenant's namespace — no coupling to
// the host's DNS/cert scripts. Cached per slug for CACHE_MS so a tenants table
// with many rows doesn't fan out a DNS+TLS probe on every render.
export interface TenantHealth {
  slug: string;
  host: string; // e.g. probe.<slug>.<consoleDomain>
  dns: "ok" | "missing" | "wrong" | "unknown";
  dnsAddresses: string[];
  cert: "ok" | "expiring" | "missing" | "mismatch" | "error" | "unknown";
  certExpiresAt: Date | null;
  certDaysLeft: number | null;
  checkedAt: Date;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { h: TenantHealth; at: number }>();
let expectedIps: { ips: string[]; at: number } | null = null;

// The server's public IPs = the platform host's A records.
async function serverIps(domain: string): Promise<string[]> {
  if (expectedIps && Date.now() - expectedIps.at < CACHE_MS * 5) return expectedIps.ips;
  const ips = await resolve4(`platform.${domain}`);
  expectedIps = { ips, at: Date.now() };
  return ips;
}

// TLS handshake against the tenant's wildcard host with SNI; reads the leaf cert.
function probeCert(host: string, servername: string): Promise<{ ok: boolean; sans: string[]; validTo: Date | null; error?: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername, rejectUnauthorized: false, timeout: 4000 }, () => {
      const cert = socket.getPeerCertificate();
      const sans = (cert?.subjectaltname ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      socket.end();
      resolve({ ok: true, sans, validTo });
    });
    socket.on("error", (e) => resolve({ ok: false, sans: [], validTo: null, error: e.message }));
    socket.on("timeout", () => { socket.destroy(); resolve({ ok: false, sans: [], validTo: null, error: "timeout" }); });
  });
}

function sanMatches(sans: string[], host: string): boolean {
  const h = host.toLowerCase();
  return sans.some((san) => {
    const s = san.toLowerCase();
    if (s === h) return true;
    if (s.startsWith("*.")) {
      const suffix = s.slice(1); // ".acme.cloud.example.com"
      return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes(".");
    }
    return false;
  });
}

export async function tenantHealth(slug: string): Promise<TenantHealth> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.h;
  const domain = consoleDomain();
  const checkedAt = new Date();
  if (!domain) {
    const h: TenantHealth = { slug, host: "", dns: "unknown", dnsAddresses: [], cert: "unknown", certExpiresAt: null, certDaysLeft: null, checkedAt };
    return h;
  }
  const host = `probe.${slug}.${domain}`;
  const [addrs, expected] = await Promise.all([resolve4(host), serverIps(domain)]);
  let dnsState: TenantHealth["dns"] = "unknown";
  if (addrs.length === 0) dnsState = "missing";
  else if (expected.length === 0) dnsState = "ok"; // can't compare; resolvable is the best we know
  else dnsState = addrs.some((a) => expected.includes(a)) ? "ok" : "wrong";

  let cert: TenantHealth["cert"] = "unknown";
  let certExpiresAt: Date | null = null;
  let certDaysLeft: number | null = null;
  if (dnsState === "ok" || dnsState === "wrong") {
    const target = expected[0] ?? addrs[0];
    const r = await probeCert(target, host);
    if (!r.ok) cert = "error";
    else if (!sanMatches(r.sans, host)) cert = "mismatch";
    else {
      certExpiresAt = r.validTo;
      certDaysLeft = r.validTo ? Math.floor((r.validTo.getTime() - Date.now()) / 86_400_000) : null;
      cert = certDaysLeft !== null && certDaysLeft < 14 ? "expiring" : "ok";
    }
  } else cert = "missing";

  const h: TenantHealth = { slug, host, dns: dnsState, dnsAddresses: addrs, cert, certExpiresAt, certDaysLeft, checkedAt };
  cache.set(slug, { h, at: Date.now() });
  return h;
}

export async function tenantsHealth(slugs: string[]): Promise<Map<string, TenantHealth>> {
  const out = new Map<string, TenantHealth>();
  const POOL = 6;
  for (let i = 0; i < slugs.length; i += POOL) {
    const batch = slugs.slice(i, i + POOL);
    const res = await Promise.all(batch.map((s) => tenantHealth(s).catch(() => null)));
    res.forEach((h, j) => { if (h) out.set(batch[j], h); });
  }
  return out;
}

export function healthProblems(h: TenantHealth): string[] {
  const p: string[] = [];
  if (h.dns === "missing") p.push("DNS record missing");
  if (h.dns === "wrong") p.push("DNS points elsewhere");
  if (h.cert === "missing" || h.cert === "error") p.push("certificate not served");
  if (h.cert === "mismatch") p.push("certificate does not cover the namespace");
  if (h.cert === "expiring") p.push(`certificate expires in ${h.certDaysLeft} days`);
  return p;
}
