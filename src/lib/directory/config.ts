import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { encrypt, decrypt } from "@/lib/crypto";


export type DirectorySecurity = "PLAIN" | "STARTTLS" | "LDAPS";

export type DirectoryConfigView = {
  enabled: boolean;
  connectorId: string | null;
  host: string;
  port: number;
  security: DirectorySecurity;
  insecureSkipVerify: boolean;
  caCertPem: string;
  baseDN: string;
  bindDN: string;
  hasBindPassword: boolean;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
};

function asSecurity(v: string): DirectorySecurity {
  return v === "PLAIN" || v === "LDAPS" ? v : "STARTTLS";
}

export async function getDirectoryConfig(): Promise<DirectoryConfigView | null> {
  let c;
  try {
    c = await db.directoryConfig.findUnique({ where: { tenantId: currentTenantId() } });
  } catch {
    // Table missing (deployed before db push) or DB down — treat as unconfigured.
    return null;
  }
  if (!c) return null;
  return {
    enabled: c.enabled,
    connectorId: c.connectorId,
    host: c.host,
    port: c.port,
    security: asSecurity(c.security),
    insecureSkipVerify: c.insecureSkipVerify,
    caCertPem: c.caCertPem ?? "",
    baseDN: c.baseDN,
    bindDN: c.bindDN,
    hasBindPassword: c.bindPassword.length > 0,
    lastTestedAt: c.lastTestedAt,
    lastTestOk: c.lastTestOk,
    lastTestDetail: c.lastTestDetail,
  };
}

// The decrypted bind password — sent to the data-plane's /ldap-test over the
// internal, secret-gated channel. Never returned to the browser.
export async function getDirectoryBindPassword(): Promise<string | null> {
  const c = await db.directoryConfig.findUnique({ where: { tenantId: currentTenantId() }, select: { bindPassword: true } });
  if (!c || !c.bindPassword) return null;
  return decrypt(c.bindPassword);
}

export async function saveDirectoryConfig(input: {
  enabled: boolean;
  connectorId: string | null;
  host: string;
  port: number;
  security: DirectorySecurity;
  insecureSkipVerify: boolean;
  caCertPem?: string;
  baseDN: string;
  bindDN: string;
  bindPassword?: string; // omitted/blank => keep the existing one
}): Promise<void> {
  const host = input.host.trim();
  const baseDN = input.baseDN.trim();
  const bindDN = input.bindDN.trim();
  const caCertPem = (input.caCertPem ?? "").trim();
  const port = Number.isFinite(input.port) && input.port > 0 ? Math.floor(input.port) : 389;
  const security = asSecurity(input.security);
  const connectorId = input.connectorId?.trim() || null;
  const secretProvided = typeof input.bindPassword === "string" && input.bindPassword.length > 0;
  const encSecret = secretProvided ? encrypt(input.bindPassword!.trim()) : undefined;

  // The reset account is sealed for this directory's host and port: another
  // directory needs it entered again.
  const prev = await db.directoryConfig.findUnique({ where: { tenantId: currentTenantId() }, select: { host: true, port: true } });
  const moved = !!prev && (prev.host !== host || prev.port !== port);

  await db.directoryConfig.upsert({
    where: { tenantId: currentTenantId() },
    create: {
      tenantId: currentTenantId(), enabled: input.enabled, connectorId, host, port, security,
      insecureSkipVerify: input.insecureSkipVerify, caCertPem, baseDN, bindDN, bindPassword: encSecret ?? "",
    },
    update: {
      enabled: input.enabled, connectorId, host, port, security,
      insecureSkipVerify: input.insecureSkipVerify, caCertPem, baseDN, bindDN,
      ...(encSecret !== undefined ? { bindPassword: encSecret } : {}),
      ...(moved ? { resetUsername: "", resetSeals: Prisma.DbNull } : {}),
    },
  });
}

export async function recordDirectoryTest(ok: boolean, detail: string): Promise<void> {
  await db.directoryConfig
    .update({ where: { tenantId: currentTenantId() }, data: { lastTestedAt: new Date(), lastTestOk: ok, lastTestDetail: detail.slice(0, 500) } })
    .catch(() => {});
}
