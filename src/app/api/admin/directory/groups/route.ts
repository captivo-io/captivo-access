import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { getDirectoryConfig, getDirectoryBindPassword } from "@/lib/directory/config";
import { searchDirectoryGroups } from "@/lib/connector/dataplane";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY = 64;

// Directory groups matching ?q=, for the Group mappings picker. Read-only.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const query = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  if (query.length < 2) return NextResponse.json({ ok: true, groups: [] });

  const cfg = await getDirectoryConfig();
  if (!cfg || !cfg.enabled || !cfg.connectorId) {
    return NextResponse.json({ ok: false, groups: [], error: "Enable and save the directory connection to search its groups." });
  }
  const bindPassword = (await getDirectoryBindPassword()) ?? "";
  const r = await searchDirectoryGroups({
    connectorId: cfg.connectorId,
    host: cfg.host,
    port: cfg.port,
    security: cfg.security,
    insecureSkipVerify: cfg.insecureSkipVerify,
    caCertPem: cfg.caCertPem,
    baseDN: cfg.baseDN,
    bindDN: cfg.bindDN,
    bindPassword,
    query,
  });
  if (r.error) return NextResponse.json({ ok: false, groups: [], error: r.error });
  return NextResponse.json({ ok: true, groups: r.groups, truncated: !!r.truncated });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
