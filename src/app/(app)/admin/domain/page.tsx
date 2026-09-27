import { requireCapability } from "@/lib/current-user";
import { accessDomain, wildcardRecord } from "@/lib/domain/custom-domain";
import { DomainVerifier } from "./domain-verifier";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { withRequestTenant } from "@/lib/tenant/request";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { siteHostSuffix } from "@/lib/site/host-suffix";
// Shared and BOUNDED: this runs during the page render.
import { resolve4 } from "@/lib/site/verify-domain";

export const dynamic = "force-dynamic";
export const metadata = { title: "Custom domain" };

async function AdminDomainPageImpl() {
  await requireCapability("configure");

  // Cloud: DNS and TLS for the tenant's app namespace are provisioned by the
  // platform — there is no record for the tenant to add. (Not linked from the
  // nav on Cloud; reachable by URL only.)
  if (multiTenantEnabled()) {
    const suffix = await siteHostSuffix();
    return (
      <main>
        <div className="page-head">
          <div>
            <div className="page-title-row"><h1>Domain</h1></div>
            <p>Managed for you — nothing to configure.</p>
          </div>
        </div>
        <div className="card">
          <p>
            Your apps are published under <code>*{suffix ?? ".<your-tenant-domain>"}</code>. DNS and HTTPS certificates
            for that namespace are provisioned automatically by the platform.
          </p>
          <p className="cell-sub">
            To publish an app on a domain you own instead (e.g. <code>portal.yourcompany.com</code>), open the resource,
            switch its address to <b>Custom domain</b>, point your DNS at the address shown there and click Verify.
          </p>
        </div>
      </main>
    );
  }

  const domain = accessDomain(process.env.MANAGER_PUBLIC_URL, process.env.ACCESS_DOMAIN);
  let serverIp: string | null = null;
  if (domain) {
    try {
      serverIp = (await resolve4(`manager.${domain}`))[0] ?? null;
    } catch {
      serverIp = null;
    }
  }
  const record = domain ? wildcardRecord(domain) : "*.<your-access-domain>";
  const ip = serverIp ?? "<your-server-IP>";

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><h1>Custom domain</h1></div>
          <p>Point one wildcard DNS record at this server; every vendor app then gets HTTPS automatically.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>1. Add this DNS record</h2></div>
        <p>At your DNS provider, add a single record — it covers every current and future app subdomain:</p>
        <div className="row-actions">
          <pre className="code"><code>{record}    A    {ip}</code></pre>
          {domain && <CopyButton value={record} label="Copy record" />}
        </div>
        {!domain && (
          <p className="cell-sub">
            Set <code>MANAGER_PUBLIC_URL</code> (e.g. https://manager.access.yourcompany.com) so we can show your exact values.
          </p>
        )}
        <p className="cell-sub">
          TLS is automatic — each app gets its certificate the first time it is opened. You only add this record once.
        </p>
      </div>

      <div className="card">
        <div className="card-head"><h2>2. Verify</h2></div>
        <DomainVerifier canVerify={!!domain} />
      </div>
    </main>
  );
}

export default async function AdminDomainPage(...args: Parameters<typeof AdminDomainPageImpl>) {
  return withRequestTenant(() => AdminDomainPageImpl(...args));
}

