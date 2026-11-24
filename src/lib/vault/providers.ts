// Credentials kept in the customer's own vault (HashiCorp Vault, CyberArk): the
// admin enters a reference instead of a password, and it is sealed to the
// connector like any secret. The connector asks the vault each time a session
// needs the credential (connector/vaultprovider.go); nothing is cached.

export const VAULT_PROVIDER_MIN_CONNECTOR = "2.66.0";

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
  address: string;
  appId: string;
  safe: string;
  object: string;
  folder?: string;
  clientCert?: string;
  clientKey?: string;
  caPem?: string;
  insecure?: boolean;
};

export type VaultRef = HashiCorpRef | CyberArkRef;

/** What is wrong with a reference the form built, or null. The connector checks it again. */
export function refProblem(r: VaultRef): string | null {
  try {
    const u = new URL(r.address.trim());
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
  if (!r.appId || !r.safe || !r.object) return "Enter the application id, the safe and the object.";
  if (!!r.clientCert !== !!r.clientKey) return "A client certificate needs its private key.";
  return null;
}

/** The text that gets sealed in place of a password. Empty strings are left out. */
export function refText(r: VaultRef): string {
  const clean = Object.fromEntries(Object.entries({ ...r, address: r.address.trim() }).filter(([, v]) => v !== "" && v !== undefined && v !== false));
  return REF_PREFIX + JSON.stringify(clean);
}

export const providerLabel = (s: string | null | undefined) => (s === "cyberark" ? "CyberArk" : s === "hashicorp" ? "HashiCorp Vault" : null);
