import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// True when the first non-empty, non-comment line is the "use client" directive
// (single or double quoted). Client components render on the browser — they
// never touch the server-side tenant scope, so the RSC wrapping invariant does
// not apply to them.
export function isClientComponent(src: string): boolean {
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    return /^["']use client["']/.test(line);
  }
  return false;
}

// True when the source references the named tenant wrapper (import or call) —
// a cheap textual check, not a full parse.
export function referencesWrapper(
  src: string,
  name: "withRequestTenant" | "withTenantRoute" | "withDeferredTenantRoute",
): boolean {
  return new RegExp(`\\b${name}\\b`).test(src);
}

/**
 * True when a route's DB work runs under the acting tenant, whichever way it gets
 * there.
 *
 * withTenantRoute opens the scope around the whole handler. withDeferredTenantRoute
 * opens none -- for a route whose slow part must not hold a transaction, like a
 * multi-minute file transfer -- and hands the tenant id over instead, so the
 * handler has to scope its own phases with inTenant. Accepting the deferred wrapper
 * ALONE would let a route resolve a tenant and then query outside any scope, which
 * is the isolation hole this whole invariant exists to prevent. Both halves, or it
 * does not count.
 */
export function routeIsTenantScoped(src: string): boolean {
  if (referencesWrapper(src, "withTenantRoute")) return true;
  return referencesWrapper(src, "withDeferredTenantRoute") && /\binTenant\b/.test(src);
}

// Names of HTTP-method handlers exported as a bare `export [async] function
// NAME` — i.e. NOT routed through `withTenantRoute`. Scanned methods: GET POST
// PUT PATCH DELETE.
export function bareMethodExports(src: string): string[] {
  return METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src));
}

// Recursive directory walk (no new deps) returning every file path under `dir`
// for which `predicate` is true.
export function listFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (predicate(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}
