import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { getOwnOidcConfig } from "@/lib/auth/oidc-config";
import { discover, IDP_TIMEOUT_MS } from "@/lib/auth/oidc";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { verifyResultFields } from "@/lib/admin/verify-result";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { runSsoTest } from "./steps";

// Tests the tenant's OWN saved provider (never Captivo ID): discovery, then its
// signing keys, then whether a client ID and secret are saved. Two IdP calls of
// up to IDP_TIMEOUT_MS each, so the route holds the slow scope.
export const POST = withTenantRoute(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const own = await getOwnOidcConfig();
  const cfg = own && !own.ignored ? own : null;
  const result = await runSsoTest(cfg, {
    discover,
    fetchJwks: async (uri) => {
      const res = await fetchWithTimeout(uri, { timeoutMs: IDP_TIMEOUT_MS, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  if (cfg) {
    await db.oidcConfig.updateMany({
      where: { tenantId: currentTenantId() },
      data: verifyResultFields(result.ok, result.ok ? null : (result.error ?? "failed"), new Date()),
    });
  }
  return NextResponse.json(result);
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
