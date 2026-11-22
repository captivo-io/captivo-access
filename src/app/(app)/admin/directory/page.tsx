import { requireCapability } from "@/lib/current-user";
import { getDirectoryConfig } from "@/lib/directory/config";
import { listGroupMappings } from "@/lib/directory/mappings";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { DirectoryView } from "./directory-view";
import { ResetAccount } from "./reset-account";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Directory (LDAP/AD)" };

async function AdminDirectoryPageImpl() {
  await requireCapability("configure");
  const [ws, cfg, connectors, mappings, sites] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    getDirectoryConfig(),
    db.connector.findMany({
      where: { status: { not: "REVOKED" } },
      select: { id: true, name: true, status: true, vaultPublicKey: true },
      orderBy: { name: "asc" },
    }),
    listGroupMappings(),
    db.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const initial = {
    enabled: cfg?.enabled ?? false,
    connectorId: cfg?.connectorId ?? "",
    host: cfg?.host ?? "",
    port: cfg?.port ?? 636,
    security: cfg?.security ?? ("LDAPS" as const),
    insecureSkipVerify: cfg?.insecureSkipVerify ?? false,
    caCertPem: cfg?.caCertPem ?? "",
    baseDN: cfg?.baseDN ?? "",
    bindDN: cfg?.bindDN ?? "",
    hasBindPassword: cfg?.hasBindPassword ?? false,
  };
  const reset = await db.directoryConfig.findFirst({ select: { resetUsername: true, resetSeals: true } });
  const resetKeys = reset?.resetSeals && typeof reset.resetSeals === "object" ? Object.keys(reset.resetSeals as object) : [];
  const configured = !!(cfg && cfg.connectorId && cfg.host && cfg.baseDN && cfg.bindDN);

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Identity &amp; access{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Directory (LDAP / Active Directory)</h1>
          <p>
            Reach the customer&apos;s internal directory through a connector, then map AD groups to console roles or
            resource access. At every sign-in, role and access are reconciled to group membership; a directory user in
            no mapped group is deprovisioned automatically.
          </p>
        </div>
      </div>
      <DirectoryView
        initial={initial}
        configured={configured}
        lastTestOk={cfg?.lastTestOk ?? null}
        lastTestDetail={cfg?.lastTestDetail ?? null}
        connectors={connectors.map((c) => ({ id: c.id, name: c.name, online: c.status === "ONLINE" }))}
        mappings={mappings}
        sites={sites}
      />
      {cfg && <ResetAccount
        host={cfg.host} port={cfg.port} security={cfg.security} username={reset?.resetUsername ?? ""}
        missingFor={reset?.resetUsername ? connectors.filter((c) => c.vaultPublicKey && !resetKeys.includes(c.vaultPublicKey)).map((c) => c.name) : []}
        keys={connectors.filter((c) => c.vaultPublicKey).map((c) => ({ name: c.name, key: c.vaultPublicKey! }))}
      />}
    </main>
  );
}

export default async function AdminDirectoryPage(...args: Parameters<typeof AdminDirectoryPageImpl>) {
  return withRequestTenant(() => AdminDirectoryPageImpl(...args));
}
