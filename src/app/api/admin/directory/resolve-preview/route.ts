import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { getDirectoryConfig, getDirectoryBindPassword } from "@/lib/directory/config";
import { resolveDirectoryUser } from "@/lib/connector/dataplane";
import { listGroupMappingsLite } from "@/lib/directory/mappings";
import { computeReconcile } from "@/lib/directory/reconcile";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dry-run: shows what a user WOULD get on login. Never writes. Because the
// target user is not being deprovisioned here, the preview computes the
// decision as if directoryManaged=true so admins can see "would deprovision".
export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email) return NextResponse.json({ ok: false, error: "Enter an email address." }, { status: 400 });

  const cfg = await getDirectoryConfig();
  if (!cfg || !cfg.enabled || !cfg.connectorId) {
    return NextResponse.json({ ok: false, error: "Enable and save the directory connection first." });
  }

  const bindPassword = (await getDirectoryBindPassword()) ?? "";
  const resolved = await resolveDirectoryUser({
    connectorId: cfg.connectorId,
    host: cfg.host,
    port: cfg.port,
    security: cfg.security,
    insecureSkipVerify: cfg.insecureSkipVerify,
    caCertPem: cfg.caCertPem,
    baseDN: cfg.baseDN,
    bindDN: cfg.bindDN,
    bindPassword,
    email,
  });
  if (resolved.error) return NextResponse.json({ ok: false, error: resolved.error });

  const mappings = await listGroupMappingsLite();
  const groups = resolved.found ? resolved.memberOf ?? [] : [];
  const decision = computeReconcile(groups, mappings, { directoryManaged: true });

  return NextResponse.json({
    ok: true,
    found: resolved.found,
    displayName: resolved.displayName ?? null,
    groups,
    decision,
  });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
