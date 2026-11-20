import { AsyncLocalStorage } from "node:async_hooks";

// The implicit tenant for the self-hosted single-tenant product, and the
// fallback whenever no tenant scope has been established.
export const DEFAULT_TENANT = "default";

// The ambient scope: the active tenant, and (multi-tenant mode) the request
// transaction whose connection carries the tenant GUC — so `db` can route every
// query onto it (see db.ts). `tx` is unknown here to keep this module free of a
// db import (avoids a context ← db ← scope cycle).
type TenantScope = { tenantId: string; tx?: unknown };
const als = new AsyncLocalStorage<TenantScope>();

// Low-level: run `fn` under the given scope. The public entry point that opens
// the request transaction and fills `tx` lives in scope.ts (production) — this
// stays db-free.
export function withScope<T>(scope: TenantScope, fn: () => T): T {
  return als.run(scope, fn);
}

// The active tenant, or DEFAULT_TENANT when no scope is set (self-host, where
// the context is never entered).
export function currentTenantId(): string {
  return als.getStore()?.tenantId ?? DEFAULT_TENANT;
}

// The ambient request transaction, or null when none is set (self-host / outside
// a withTenant scope). db.ts routes queries onto it when present. Tenant
// enforcement is entirely in the database (RLS reads + an insert trigger for
// writes, both GUC-driven), so no ALS-based query filtering is needed — that was
// tried and proved flaky inside Prisma's interactive-transaction query pipeline.
export function currentTx(): unknown | null {
  return als.getStore()?.tx ?? null;
}

// Runs fn with no scope at all: for work started from inside a request that
// must outlive it (a timer would otherwise inherit the request's transaction,
// which is closed by the time the timer fires).
export function outsideScope<T>(fn: () => T): T {
  return als.exit(fn);
}
