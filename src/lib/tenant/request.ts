import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { consoleDomain, slugFromHost } from "@/lib/tenant/console-domain";
import { resolveTenantBySlug } from "@/lib/tenant/resolve";
import { withTenant, type TenantScopeOptions } from "@/lib/tenant/scope";
import { inTenant } from "@/lib/cron/for-each-tenant";
import { multiTenantEnabled } from "@/lib/tenant/enabled";

// Resolves the request's tenant from its host: <slug>.<consoleDomain> → slug →
// tenant id (via the SECURITY DEFINER resolver). Null when the host carries no
// tenant slug or the slug is unknown.
//
// The console domain (where tenant consoles live) can differ from the site
// domain: when CONSOLE_DOMAIN is set, tenant slugs resolve under it; otherwise it
// falls back to the access domain, so a deployment that co-locates consoles and
// sites under one domain (and the single-tenant default) is unchanged.
export async function resolveRequestTenant(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const slug = slugFromHost(host, consoleDomain());
  if (!slug) return null;
  return resolveTenantBySlug(slug);
}

// The acting tenant's slug from the request's console host (<slug>.<consoleDomain>),
// without a DB lookup. Null off a tenant/console host. Used to namespace vendor
// site hostnames per tenant.
export async function resolveRequestTenantSlug(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return slugFromHost(host, consoleDomain());
}

// Wraps a route handler so its DB work runs under the request's tenant scope.
// Self-host (flag off): pass-through, unchanged. Cloud: resolve the tenant and
// enter withTenant; an unresolvable host is a 404 (unknown tenant).
export function withTenantRoute<A extends unknown[]>(
  handler: (...a: A) => Promise<Response>,
  // Pass { budgetMs: SLOW_SCOPE_BUDGET_MS } when this route waits on a third
  // party. The scope is a transaction, so the handler's whole wait is inside it.
  opts?: TenantScopeOptions,
): (...a: A) => Promise<Response> {
  return async (...a: A) => {
    if (!multiTenantEnabled()) return handler(...a);
    const tenantId = await resolveRequestTenant();
    if (!tenantId) return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
    return withTenant(tenantId, () => handler(...a), opts);
  };
}

// Wraps an RSC page/layout body so its DB work runs under the request's tenant
// scope. Each RSC render is invoked independently, so each wraps its own body.
// Self-host: pass-through. Cloud: resolve + withTenant; unresolvable host → 404.
export async function withRequestTenant<T>(fn: () => Promise<T>, opts?: TenantScopeOptions): Promise<T> {
  if (!multiTenantEnabled()) return fn();
  const tenantId = await resolveRequestTenant();
  if (!tenantId) notFound();
  return withTenant(tenantId, fn, opts);
}

/**
 * Resolves the request's tenant and hands it to the handler WITHOUT opening a
 * scope. The handler wraps its own DB phases with `inTenant`.
 *
 * For a route whose slow part cannot be covered by any sane transaction budget: an
 * isolated-browser file transfer may legitimately run for minutes, and a recording
 * replay streams. Raising a scope budget to match would hold a pooled database
 * connection for the whole transfer -- and a budget SHORTER than the transfer
 * simply breaks it, which is what a 300 s upload ceiling inside a 30 s scope did.
 *
 * The shape is read-scoped, work-unscoped, write-scoped, the same split that fixed
 * the site-health cron. Self-host (flag off) passes null and the handler runs
 * unscoped, exactly as before.
 */
export function withDeferredTenantRoute<A extends unknown[]>(
  handler: (tenantId: string | null, ...a: A) => Promise<Response>,
): (...a: A) => Promise<Response> {
  return async (...a: A) => {
    if (!multiTenantEnabled()) return handler(null, ...a);
    const tenantId = await resolveRequestTenant();
    if (!tenantId) return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
    return handler(tenantId, ...a);
  };
}

export { inTenant };
