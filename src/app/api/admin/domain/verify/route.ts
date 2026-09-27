import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { accessDomain, wildcardRecord, classifyVerify } from "@/lib/domain/custom-domain";
import { withTenantRoute } from "@/lib/tenant/request";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
// Shared and BOUNDED: dns.promises.resolve4 takes no per-call timeout, and this
// route runs inside a request. See lib/site/verify-domain.ts.
import { resolve4 } from "@/lib/site/verify-domain";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const dynamic = "force-dynamic";

export const POST = withTenantRoute(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Cloud: the wildcard record is the platform's, not the tenant's — nothing to verify.
  if (multiTenantEnabled()) return NextResponse.json({ error: "not_applicable" }, { status: 404 });

  const domain = accessDomain(process.env.MANAGER_PUBLIC_URL, process.env.ACCESS_DOMAIN);
  if (!domain) return NextResponse.json({ status: "undetermined", reason: "no_domain" });

  // Expected server IP = the A record of the manager's own hostname.
  const expected = await resolve4(`manager.${domain}`);
  if (expected.length === 0) {
    return NextResponse.json({ status: "undetermined", reason: "manager_unresolved", record: wildcardRecord(domain) });
  }
  const expectedIp = expected[0];

  // Probe a throwaway label to test the wildcard record — no real Site needed,
  // and the unique label avoids any resolver cache.
  const probe = `wildcard-check-${Date.now().toString(36)}.${domain}`;
  const resolved = await resolve4(probe);

  return NextResponse.json({
    status: classifyVerify(expectedIp, resolved),
    record: wildcardRecord(domain),
    expectedIp,
    resolvedIp: resolved[0] ?? null,
  });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
