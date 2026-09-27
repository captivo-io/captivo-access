import { promises as dns } from "node:dns";
import { classifyVerify, type VerifyStatus } from "@/lib/domain/custom-domain";

export function verifyDecision(expectedIp: string, resolvedIps: string[]): VerifyStatus {
  return classifyVerify(expectedIp, resolvedIps);
}

/**
 * Ceiling for a DNS lookup.
 *
 * `dns.promises.resolve4` takes no per-call timeout: it uses the resolver's own,
 * which on an unresponsive nameserver means seconds per try times several tries.
 * A dedicated Resolver is the only place the limit can be set, and these lookups
 * run on request paths (domain verification, the domain page's render).
 */
const DNS_TIMEOUT_MS = 5_000;
const DNS_TRIES = 2;

function boundedResolver(): dns.Resolver {
  return new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
}

export async function resolve4(host: string): Promise<string[]> {
  try {
    return await boundedResolver().resolve4(host);
  } catch {
    return [];
  }
}

// The server IP tenants must point their domain at = the A record of the
// manager's own public host (MANAGER_PUBLIC_URL host).
export async function expectedServerIp(): Promise<string | null> {
  const raw = process.env.MANAGER_PUBLIC_URL;
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  return (await resolve4(host))[0] ?? null;
}
