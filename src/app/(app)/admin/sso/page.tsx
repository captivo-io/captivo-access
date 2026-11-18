import { headers } from "next/headers";
import { requireCapability } from "@/lib/current-user";
import { getOwnOidcConfig } from "@/lib/auth/oidc-config";
import { readPlatformOidc } from "@/lib/auth/oidc-source";
import { workspaceView } from "@/lib/mobile/views";
import { SsoForm } from "./sso-form";
import { staffSignIn } from "./providers";
import { withRequestTenant } from "@/lib/tenant/request";
import { managerBaseUrlFromHeaders } from "@/lib/url";

export const dynamic = "force-dynamic";
export const metadata = { title: "Single sign-on" };

async function AdminSsoPageImpl() {
  await requireCapability("configure");
  // The tenant's own row only. Captivo ID's values are never put in the form:
  // saving them created a secret-less "own" provider that replaced Captivo ID.
  const [own, ws] = await Promise.all([
    getOwnOidcConfig(),
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
  ]);
  const cfg = own && !own.ignored ? own : null;
  const captivoId = readPlatformOidc(process.env) !== null;

  // Show the redirect URI to register in the IdP — the same base the OIDC
  // start/callback routes use (on Cloud: this tenant's own console host).
  const redirectUri = `${managerBaseUrlFromHeaders(await headers())}/api/auth/oidc/callback`;

  const initial = {
    exists: cfg !== null,
    enabled: cfg?.enabled ?? false,
    issuer: cfg?.issuer ?? "",
    clientId: cfg?.clientId ?? "",
    buttonLabel: cfg?.buttonLabel ?? "",
    hasSecret: cfg?.hasSecret ?? false,
    lastTestOk: cfg?.lastVerifiedOk === true,
  };
  const staff = staffSignIn(cfg ? { enabled: cfg.enabled, issuer: cfg.issuer } : null, captivoId);

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Identity &amp; access{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Single sign-on (OIDC)</h1>
          <p>Let admins and operators sign in with your own identity provider (Microsoft Entra, Google Workspace, Okta). Vendors always use passkeys.</p>
        </div>
      </div>

      <section className="so-methods" aria-label="How people sign in">
        <div className="so-method">
          <span className="so-method-ic p" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          </span>
          <span className="so-method-t"><span className="so-method-who">Admin &amp; operator</span><b>{staff.how}</b><span className="cell-sub">{staff.sub}</span></span>
        </div>
        <div className="so-method">
          <span className="so-method-ic a" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.5 12.5 21 2" /><path d="M16 7l3 3" /></svg>
          </span>
          <span className="so-method-t"><span className="so-method-who">Vendor</span><b>Passkey</b><span className="cell-sub">Unchanged. Single sign-on does not apply to vendors.</span></span>
        </div>
      </section>

      <SsoForm initial={initial} redirectUri={redirectUri} captivoId={captivoId} />
    </main>
  );
}

export default async function AdminSsoPage(...args: Parameters<typeof AdminSsoPageImpl>) {
  return withRequestTenant(() => AdminSsoPageImpl(...args));
}
