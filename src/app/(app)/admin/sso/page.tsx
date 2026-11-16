import { headers } from "next/headers";
import { requireCapability } from "@/lib/current-user";
import { getOwnOidcConfig } from "@/lib/auth/oidc-config";
import { readPlatformOidc } from "@/lib/auth/oidc-source";
import { LastVerified } from "@/app/(app)/_shell/last-verified";
import { SsoForm } from "./sso-form";
import { withRequestTenant } from "@/lib/tenant/request";
import { managerBaseUrlFromHeaders } from "@/lib/url";

export const dynamic = "force-dynamic";
export const metadata = { title: "Single sign-on" };

async function AdminSsoPageImpl() {
  await requireCapability("configure");
  // The tenant's own row only. Captivo ID's values are never put in the form:
  // saving them created a secret-less "own" provider that replaced Captivo ID.
  const own = await getOwnOidcConfig();
  const cfg = own && !own.ignored ? own : null;
  const captivoId = readPlatformOidc(process.env) !== null;

  // Show the redirect URI to register in the IdP — the same base the OIDC
  // start/callback routes use (on Cloud: this tenant's own console host).
  const redirectUri = `${managerBaseUrlFromHeaders(await headers())}/api/auth/oidc/callback`;

  const initial = {
    enabled: cfg?.enabled ?? false,
    issuer: cfg?.issuer ?? "",
    clientId: cfg?.clientId ?? "",
    buttonLabel: cfg?.buttonLabel ?? "",
    hasSecret: cfg?.hasSecret ?? false,
  };
  const status = cfg
    ? cfg.enabled
      ? "Users sign in with the provider below."
      : captivoId
        ? "Your provider below is switched off, so the login page has no SSO button. Remove it to sign in with Captivo again."
        : "Your provider below is switched off, so the login page has no SSO button."
    : captivoId
      ? "Users sign in with Captivo. Add your own identity provider below only if you want it to replace Captivo."
      : null;

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.5 12.5 21 2"/><path d="M16 7l3 3"/></svg></span><h1>Single sign-on (OIDC)</h1></div>
          <p>Let internal users sign in with your identity provider (Microsoft Entra, Google Workspace, Okta). Vendors continue to use passkeys.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Register this redirect URI in your IdP</h2></div>
        <pre className="code"><code>{redirectUri}</code></pre>
        <p className="cell-sub">Create an OIDC app in your IdP, add the redirect URI above, then paste its Issuer, Client ID, and Client secret below. Request scopes <code>openid email profile</code>.</p>
      </div>
      <div className="card">
        <LastVerified at={cfg?.lastVerifiedAt ?? null} ok={cfg?.lastVerifiedOk ?? null} detail={cfg?.lastVerifiedDetail ?? null} />
        {status && <p className="cell-sub" style={{ marginBottom: "1rem" }}>{status}</p>}
        <SsoForm initial={initial} canRemove={own !== null} captivoId={captivoId} />
      </div>
    </main>
  );
}

export default async function AdminSsoPage(...args: Parameters<typeof AdminSsoPageImpl>) {
  return withRequestTenant(() => AdminSsoPageImpl(...args));
}

