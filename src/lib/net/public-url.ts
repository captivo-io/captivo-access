import { isIP } from "node:net";

// Addresses a Cloud server must not be steered at on a workspace admin's say-so
// (see guarded-fetch.ts): private, loopback, link-local, CGNAT, multicast.

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
