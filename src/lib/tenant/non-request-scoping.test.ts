import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CI guard: every `route.ts` under the non-request entry-point directories
 * (internal data-plane, cron jobs, connector enrollment/auth) must reference
 * a tenant-scope helper (`withTenantFrom`, `withTenant`, or `forEachTenant`).
 *
 * These endpoints do not run under the ambient request-tenant middleware, so
 * without an explicit scope call a handler can read/write across tenants.
 * This test walks the directories, greps each route file for the helper
 * regex, and fails naming any file that isn't scoped AND isn't on the
 * explicit allowlist below.
 *
 * If you are adding a new non-request endpoint that genuinely needs no
 * tenant scope (e.g. it touches no tenant data), add it to the allowlist
 * with a comment explaining why — do not just delete the assertion.
 */

const SCOPE_HELPER_RE = /\bwithTenantFrom\b|\bforEachTenant\b|\bwithTenant\b/;

const ROOT = path.resolve(__dirname, "../../..");

const SCAN_DIRS = [
  "src/app/api/internal",
  "src/app/api/cron",
  "src/app/api/connector",
];

// Explicit allowlist of route.ts files exempt from the tenant-scope check.
// Every entry must carry a reason.
const ALLOWLIST: Record<string, string> = {
  "src/app/api/internal/recorder/route.ts":
    "Serves a static JS bundle asset; no DB access, no tenant data involved.",
  "src/app/api/internal/connector/auth/route.ts":
    "Tenant scoping lives in src/lib/connector/enrollment.ts (validateConnectorToken); this route performs no writes of its own.",
  "src/app/api/connector/enroll/route.ts":
    "Tenant scoping lives in src/lib/connector/enrollment.ts (redeemPairing); the route file itself does not scope.",
  "src/app/api/internal/recording/ingest-guac/route.ts":
    "Retired (410): recording bytes live on the connector. Reads nothing, writes nothing, touches no tenant data.",
  "src/app/api/internal/recording/ingest-video/route.ts":
    "Retired (410): recording bytes live on the connector. Reads nothing, writes nothing, touches no tenant data.",
  "src/app/api/internal/recording/finalize-video/route.ts":
    "Retired (410): recording bytes live on the connector. Reads nothing, writes nothing, touches no tenant data.",
  "src/app/api/internal/recording/keyevents/route.ts":
    "Retired (410): keystroke events live on the connector. Reads nothing, writes nothing, touches no tenant data.",
};

function walkRouteFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkRouteFiles(full));
    } else if (entry.isFile() && entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results;
}

describe("non-request endpoints declare a tenant scope", () => {
  it("every route.ts under internal/cron/connector references a tenant-scope helper, unless allowlisted", () => {
    const routeFiles = SCAN_DIRS.flatMap((dir) =>
      walkRouteFiles(path.join(ROOT, dir))
    );

    expect(routeFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];

    for (const absPath of routeFiles) {
      const relPath = path.relative(ROOT, absPath).split(path.sep).join("/");
      if (relPath in ALLOWLIST) continue;

      const contents = fs.readFileSync(absPath, "utf8");
      if (!SCOPE_HELPER_RE.test(contents)) {
        offenders.push(relPath);
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `The following non-request endpoint(s) do not reference a tenant-scope helper ` +
          `(withTenantFrom / withTenant / forEachTenant) and are not on the allowlist ` +
          `in src/lib/tenant/non-request-scoping.test.ts:\n${offenders
            .map((f) => `  - ${f}`)
            .join("\n")}\n` +
          `Either wrap the handler with a scope helper, or add it to the allowlist with a reason.`
        : undefined
    ).toEqual([]);
  });

  it("every allowlisted file still exists (catch stale allowlist entries)", () => {
    for (const relPath of Object.keys(ALLOWLIST)) {
      const absPath = path.join(ROOT, relPath);
      expect(fs.existsSync(absPath), `allowlisted file missing: ${relPath}`).toBe(
        true
      );
    }
  });
});
