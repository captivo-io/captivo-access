import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * A tenant scope is a transaction, so nothing slow may run inside one.
 *
 * `withTenant` (and therefore `forEachTenant`) establishes the acting tenant by
 * opening a Prisma interactive transaction and holding it open for the whole
 * callback. That transaction's timeout is 5 s. site-health probed every site over
 * the network inside such a callback, so one slow target did not just get marked
 * unreachable -- it expired the transaction and the entire pass's results were
 * never written (P2028 at 6252 ms, observed in production).
 *
 * The rule: a cron that touches the network fans out with `forEachTenantId` and
 * wraps only its DB phases with `inTenant`.
 */
const CRON_DIR = "src/app/api/cron";

// Modules that reach off-box. A cron importing one of these cannot hold a
// transaction across the call.
const SLOW_IMPORTS = [
  "@/lib/connector/health",
  "@/lib/notifications",
  "@/lib/mail",
  "@/lib/dataplane/recordings",
];

function cronRoutes(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${CRON_DIR}/${e.name}/route.ts`);
}

describe("cron jobs keep slow work out of the tenant transaction", () => {
  it("no cron that reaches the network fans out with the scoping helper", () => {
    const offenders: string[] = [];
    for (const file of cronRoutes()) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const slow = SLOW_IMPORTS.filter((m) => src.includes(`from "${m}"`));
      if (slow.length === 0) continue;
      // The scoping variant, matched as an import so a mention in prose is not a hit.
      if (/\bforEachTenant\b(?![I])/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""))) {
        offenders.push(`${file} (imports ${slow.join(", ")})`);
      }
    }
    expect(offenders, "network work inside a 5 s transaction: use forEachTenantId + inTenant").toEqual([]);
  });

  it("site-health reads, probes and writes in that order, and probes unscoped", () => {
    const src = readFileSync(`${CRON_DIR}/site-health/route.ts`, "utf8");
    const read = src.indexOf("sites: await db.site.findMany");
    const probe = src.indexOf("await probeSite(");
    const write = src.indexOf("await db.site.update(");
    expect(read, "no read phase").toBeGreaterThan(-1);
    expect(probe, "no probe").toBeGreaterThan(-1);
    expect(write, "no write phase").toBeGreaterThan(-1);
    expect(read, "probing before reading the site list makes no sense").toBeLessThan(probe);
    expect(probe, "results must be written after probing, not during").toBeLessThan(write);

    // The probe must not sit inside an inTenant callback. Both phases use inTenant,
    // so position alone is not enough: check the probe is outside every scope block.
    const scopeBlocks = [...src.matchAll(/inTenant\([^;]*?\{([\s\S]*?)\n    \}\)/g)].map((m) => m[1]);
    for (const block of scopeBlocks) {
      expect(block, "a probe runs inside a tenant transaction").not.toContain("probeSite(");
      expect(block, "a gateway probe runs inside a tenant transaction").not.toContain("probeGatewaySite(");
    }
  });
});
