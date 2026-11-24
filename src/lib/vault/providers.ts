// Credentials kept in the customer's own vault (HashiCorp Vault, CyberArk): the
// admin enters a reference instead of a password, and it is sealed to the
// connector like any secret. The connector asks the vault each time a session
// needs the credential (connector/vaultprovider.go); nothing is cached.

export const VAULT_PROVIDER_MIN_CONNECTOR = "2.66.0";
/** Azure Key Vault, AWS Secrets Manager and CyberArk's REST API came a release later. */
export const VAULT_PROVIDER_MIN_CONNECTOR_MORE = "2.67.0";

export const REF_PREFIX = "captivo-ref1:";

export type HashiCorpRef = {
  provider: "hashicorp";
  address: string;
  namespace?: string;
  mount?: string;
  path: string;
  field?: string;
  kvVersion?: 1 | 2;
  auth: "token" | "approle";
  token?: string;
  roleId?: string;
  secretId?: string;
  authMount?: string;
  caPem?: string;
  insecure?: boolean;
};

export type CyberArkRef = {
  provider: "cyberark";
  /** "ccp": the Central Credential Provider (application id); "pvwa": the REST API (a user signs in, finds the account, retrieves its password). */
  mode?: "ccp" | "pvwa";
  address: string;
  appId?: string;
  safe?: string;
  object?: string;
  folder?: string;
  clientCert?: string;
  clientKey?: string;
  caPem?: string;
  insecure?: boolean;
  logonType?: "cyberark" | "ldap" | "radius";
  user?: string;
  password?: string;
  accountId?: string;
  reason?: string;
};

export type AzureRef = {
  provider: "azure";
  /** The vault's URL, https://name.vault.azure.net */
  address: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  secretName: string;
  secretVersion?: string;
  caPem?: string;
  insecure?: boolean;
};

export type AwsRef = {
  provider: "aws";
  region: string;
  /** Replaces the regional endpoint (a VPC endpoint). */
  address?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  awsSecretId: string;
  jsonKey?: string;
  caPem?: string;
  insecure?: boolean;
};

export type VaultRef = HashiCorpRef | CyberArkRef | AzureRef | AwsRef;

/** What is wrong with a reference the form built, or null. The connector checks it again. */
export function refProblem(r: VaultRef): string | null {
  const addr = r.provider === "aws" ? (r.address?.trim() || `https://secretsmanager.${r.region || "eu-central-1"}.amazonaws.com`) : r.address.trim();
  try {
    const u = new URL(addr);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.search || u.hash) return "The vault's address must be https://host[:port].";
  } catch {
    return "The vault's address must be https://host[:port].";
  }
  if (r.caPem && !r.caPem.includes("BEGIN CERTIFICATE")) return "Paste the CA certificate in PEM form.";
  if (r.provider === "hashicorp") {
    if (!r.path.replace(/[\s/]/g, "")) return "Enter the secret's path.";
    if (r.auth === "token" && !r.token) return "Enter the token.";
    if (r.auth === "approle" && (!r.roleId || !r.secretId)) return "Enter the role id and the secret id.";
    return null;
  }
  if (r.provider === "azure") {
    if (!r.tenantId || !r.clientId || !r.clientSecret) return "Enter the tenant id, the application's client id and its secret.";
    if (!r.secretName) return "Enter the secret's name.";
    return null;
  }
  if (r.provider === "aws") {
    if (!r.region || /[\s/:]/.test(r.region)) return "Enter the region, such as eu-central-1.";
    if (!r.awsSecretId) return "Enter the secret's name or ARN.";
    if (!!r.accessKeyId !== !!r.secretAccessKey) return "An access key id needs its secret key.";
    return null;
  }
  if (r.mode === "pvwa") {
    if (!r.user || !r.password) return "Enter the CyberArk user and its password.";
    if (!r.accountId && (!r.safe || !r.object)) return "Enter the account id, or the safe and the account's name.";
  } else if (!r.appId || !r.safe || !r.object) return "Enter the application id, the safe and the object.";
  if (!!r.clientCert !== !!r.clientKey) return "A client certificate needs its private key.";
  return null;
}

/** The text that gets sealed in place of a password. Empty strings are left out. */
export function refText(r: VaultRef): string {
  const clean = Object.fromEntries(Object.entries({ ...r, ...(r.address !== undefined ? { address: r.address.trim() } : {}) }).filter(([, v]) => v !== "" && v !== undefined && v !== false));
  return REF_PREFIX + JSON.stringify(clean);
}

export const providerLabel = (s: string | null | undefined) =>
  s === "cyberark" ? "CyberArk" : s === "hashicorp" ? "HashiCorp Vault" : s === "azure" ? "Azure Key Vault" : s === "aws" ? "AWS Secrets Manager" : null;
