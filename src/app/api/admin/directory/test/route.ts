import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { getDirectoryConfig, getDirectoryBindPassword, recordDirectoryTest } from "@/lib/directory/config";
import { testDirectory } from "@/lib/connector/dataplane";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tests the SAVED directory config through the connector (bind + base-DN search).
// Save the config first, then test.
export const POST = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const cfg = await getDirectoryConfig();
  if (!cfg || !cfg.connectorId) {
    return NextResponse.json({ ok: false, error: "Choose a connector and save the directory settings first." });
  }
  if (!cfg.host || !cfg.baseDN || !cfg.bindDN) {
    return NextResponse.json({ ok: false, error: "Host, base DN and bind DN are required — save them first." });
  }

  const bindPassword = (await getDirectoryBindPassword()) ?? "";
  const result = await testDirectory({
    connectorId: cfg.connectorId,
    host: cfg.host,
    port: cfg.port,
    security: cfg.security,
    insecureSkipVerify: cfg.insecureSkipVerify,
    caCertPem: cfg.caCertPem,
    baseDN: cfg.baseDN,
    bindDN: cfg.bindDN,
    bindPassword,
  });

  const detail = result.error ?? (result.baseDnFound ? "Bound OK; base DN found." : "Bound OK; base DN not found.");
  await recordDirectoryTest(result.ok, detail);
  return NextResponse.json({ ...result, detail });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
