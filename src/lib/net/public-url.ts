import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// For a test call to an address an admin typed: on Cloud the server must not
// be steered at its own network (a workspace admin could otherwise probe it
// through the answer). Private, loopback, link-local and similar ranges are
// refused there; a self-hosted install may post anywhere.

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  return fam === 4 ? privateV4(ip) : fam === 6 ? privateV6(ip) : true;
}

/** Null when the URL's host resolves only to public addresses; else a reason. */
export async function publicUrlProblem(url: string): Promise<string | null> {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid_url";
    host = u.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "invalid_url";
  }
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) return "private_address";
    return null;
  } catch {
    return "unresolvable";
  }
}
