import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { base } from "@/lib/db";
import { withTenant } from "@/lib/tenant/scope";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { timingSafeEqualStr } from "@/lib/secure-compare";

// Resolvers for non-request contexts (data-plane internal API, connector
// enrollment, cron): each maps a payload key to its tenant id via the matching
// SECURITY DEFINER function (RLS-bypass), mirroring resolveTenantBySlug in
// resolve.ts. `fn` is always one of the fixed internal function names below —
// never derived from user input — so the interpolation is safe; the key is
// always a bound $1 param.
async function callResolver(fn: string, key: string): Promise<string | null> {
  const rows = await base.$queryRawUnsafe<{ id: string | null }[]>(`SELECT ${fn}($1) AS id`, key);
  return rows[0]?.id ?? null;
}

export const resolveTenantByUser = (id: string) => callResolver("resolve_tenant_by_user", id);
export const resolveTenantBySite = (id: string) => callResolver("resolve_tenant_by_site", id);
export const resolveTenantBySessionToken = (h: string) => callResolver("resolve_tenant_by_session_token", h);
export const resolveTenantByRecordingKey = (k: string) => callResolver("resolve_tenant_by_recording_key", k);
export const resolveTenantByConnector = (id: string) => callResolver("resolve_tenant_by_connector", id);
export const resolveTenantByDbTicket = (hash: string) => callResolver("resolve_tenant_by_db_ticket", hash);
// Hostnames are stored/matched lowercased+trimmed (mirrors resolveTenantByHostname in resolve.ts).
export const resolveTenantByHostname = (host: string) => callResolver("resolve_tenant_by_hostname", host.toLowerCase().trim());

// Enumerates ACTIVE tenants (excluding the reserved 'platform' tenant) via the
// SECURITY DEFINER function, for cron/fan-out contexts with no request tenant.
export async function listActiveTenantIds(): Promise<string[]> {
  const rows = await base.$queryRawUnsafe<{ list_active_tenant_ids: string }[]>(`SELECT list_active_tenant_ids()`);
  return rows.map((r) => r.list_active_tenant_ids);
}

// Wraps a non-request route handler (cron, webhook, connector callback — any
// handler whose tenant isn't the ambient request host) to run under the
// tenant resolved from its own payload/args via `resolve`. Flag off: pass
// -through, unchanged behavior, `resolve` is never called. Flag on: resolve
// the tenant; an unresolvable key 404s as unknown_tenant rather than running
// unscoped; otherwise the handler runs inside withTenant(tid, ...).
export function withTenantFrom<A extends unknown[]>(resolve: (...a: A) => Promise<string | null>) {
  return (handler: (...a: A) => Promise<Response>) =>
    async (...a: A): Promise<Response> => {
      if (!multiTenantEnabled()) return handler(...a);
      const tid = await resolve(...a);
      if (!tid) return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
      return withTenant(tid, () => handler(...a));
    };
}

// Shared DATAPLANE_SECRET gate for the payload-keyed data-plane internal/*
// endpoints — the SAME check every handler already ran inline (constant-time
// compare of `x-dataplane-secret` against DATAPLANE_SECRET, 403 forbidden on
// failure), centralized so it can be composed OUTSIDE withTenantFrom and be
// the outermost gate. Always applies, independent of MULTI_TENANT (self-host
// must keep this check too, with the exact same response shape as before).
//
// Ordering matters: withTenantFrom's resolvers are SECURITY DEFINER (RLS
// -bypass) and, unguarded, would run before any auth check — a valid payload
// key (belonging to ANY tenant) reaches the handler (which then 403s on a bad
// secret) while an invalid key 404s "unknown_tenant" from the wrapper. That
// difference is a pre-auth, cross-tenant id-existence oracle plus does
// pre-auth DB work. Composing `requireDataplaneSecret(withTenantFrom(...)(...))`
// closes it: an unauthenticated caller never reaches tenant resolution.
export function requireDataplaneSecret<A extends unknown[]>(handler: (...a: A) => Promise<Response>) {
  return async (...a: A): Promise<Response> => {
    const req = a[0] as unknown as NextRequest;
    const s = process.env.DATAPLANE_SECRET;
    if (!s || !timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return handler(...a);
  };
}
