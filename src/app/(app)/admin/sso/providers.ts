// The identity providers the SSO page offers. Nothing about the provider is
// stored: the choice only fills placeholders, and on load it is read back from
// the saved issuer's host. Pure, so the page and its tests share it.

export type ProviderKey = "entra" | "google" | "okta" | "oidc";

export interface Provider {
  key: ProviderKey;
  label: string;
  mono: string;
  issuerPlaceholder: string;
  buttonPlaceholder: string;
}

export const PROVIDERS: Provider[] = [
  { key: "entra", label: "Microsoft Entra", mono: "M", issuerPlaceholder: "https://login.microsoftonline.com/<tenant-id>/v2.0", buttonPlaceholder: "Sign in with Microsoft" },
  { key: "google", label: "Google Workspace", mono: "G", issuerPlaceholder: "https://accounts.google.com", buttonPlaceholder: "Sign in with Google" },
  { key: "okta", label: "Okta", mono: "O", issuerPlaceholder: "https://<your-org>.okta.com", buttonPlaceholder: "Sign in with Okta" },
  { key: "oidc", label: "OIDC", mono: "◎", issuerPlaceholder: "https://idp.example.com", buttonPlaceholder: "Sign in with SSO" },
];

export function providerFromIssuer(issuer: string): ProviderKey {
  let host = "";
  try {
    host = new URL(issuer.trim()).hostname.toLowerCase();
  } catch {
    return "oidc";
  }
  if (host === "login.microsoftonline.com" || host === "sts.windows.net" || host.endsWith(".ciamlogin.com")) return "entra";
  if (host === "accounts.google.com") return "google";
  if (host.endsWith(".okta.com") || host.endsWith(".oktapreview.com") || host.endsWith(".okta-emea.com")) return "okta";
  return "oidc";
}

export const providerByKey = (k: ProviderKey): Provider => PROVIDERS.find((p) => p.key === k)!;

/**
 * How admins and operators sign in today, worded for the summary strip. Follows
 * pickOidcSource: an enabled tenant provider wins; a tenant provider that is
 * switched off means no SSO at all (no fallback to Captivo ID); with no tenant
 * provider, Captivo ID when the platform has it.
 */
export function staffSignIn(own: { enabled: boolean; issuer: string } | null, captivoId: boolean): { how: string; sub: string } {
  if (own?.enabled) return { how: `${providerByKey(providerFromIssuer(own.issuer)).label} (SSO)`, sub: "The sign-in page shows your provider's button." };
  if (own) return { how: "Passkey", sub: "Your provider is switched off, so there is no SSO button. Admins and operators sign in with a passkey." };
  if (captivoId) return { how: "Captivo ID", sub: "The default. Add your own provider below to replace it." };
  return { how: "Passkey", sub: "No identity provider is set up. Everyone signs in with a passkey." };
}

export type SsoChip = "off" | "ready" | "on";

export function ssoChip(enabled: boolean, lastTestOk: boolean): SsoChip {
  if (enabled) return "on";
  return lastTestOk ? "ready" : "off";
}
