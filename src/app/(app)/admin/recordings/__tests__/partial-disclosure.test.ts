import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * An incomplete search answer must say so, and must not replace the results.
 *
 * Command search runs on the connectors that hold the keystroke text, so an offline
 * connector makes the answer partial. The failure this guards against is specific:
 * a reader sees "No recordings match these filters" and concludes nothing happened,
 * when in truth a connector was not searched. In an investigation that is worse than
 * having no search at all.
 *
 * Asserted at the source level because the alternative is rendering a client
 * component with a fetch in it; what matters here is the wiring and the ordering,
 * both of which are visible statically.
 */
const ROOT = path.join(process.cwd(), "src/app/(app)/admin/recordings");
const table = readFileSync(path.join(ROOT, "recordings-table.tsx"), "utf8");
const api = readFileSync(
  path.join(process.cwd(), "src/app/api/admin/recordings/route.ts"),
  "utf8"
);

describe("partial search disclosure", () => {
  it("the API returns the partial signal", () => {
    expect(api).toMatch(/partial:\s*partial\s*\?\?\s*false/);
    expect(api).toMatch(/unreachableConnectors/);
  });

  it("the table reads and stores it", () => {
    expect(table).toMatch(/setPartial\(body\.partial/);
    expect(table).toMatch(/setUnreachable\(body\.unreachableConnectors/);
  });

  it("the banner renders BEFORE the empty state, not instead of results", () => {
    const banner = table.indexOf("This answer is incomplete");
    const empty = table.indexOf("No recordings match these filters");
    expect(banner, "no partial banner in the view").toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(-1);
    // If the banner were inside the empty-state branch it would never show next to
    // real rows, and a partial answer WITH results is the common case.
    expect(banner).toBeLessThan(empty);
  });

  it("the banner explains why, not just that", () => {
    // "Incomplete" alone tells an operator nothing actionable; naming connector
    // storage as the reason tells them where the missing data is.
    expect(table).toMatch(/stored on their connector/);
  });
});

/**
 * A recording cut short by the data plane's size cap must say so wherever it is
 * shown. Until 2.1.4 a 500 MiB default stopped capture silently: the list showed a
 * shorter recording and the player simply ended, which in an investigation reads as
 * the session having ended there.
 */
describe("cut-short recording disclosure", () => {
  const player = readFileSync(path.join(ROOT, "[id]/page.tsx"), "utf8");
  const query = readFileSync(path.join(process.cwd(), "src/lib/recording/query.ts"), "utf8");

  it("the index carries the flag and the API passes it through", () => {
    expect(query).toMatch(/truncated:\s*true/);
    expect(api).toMatch(/truncated:\s*r\.truncated/);
  });

  it("the list labels the row", () => {
    expect(table).toMatch(/r\.truncated\s*\?/);
    expect(table).toContain("cut short");
  });

  it("the player says the replay ends before the session did", () => {
    expect(player).toMatch(/rec\.truncated\s*\?/);
    expect(player).toContain("RECORDING_MAX_BYTES");
    const notice = player.indexOf("This recording is incomplete");
    const card = player.indexOf('<div className="card">');
    expect(notice).toBeGreaterThan(-1);
    expect(notice, "the notice must come before the player, not after it").toBeLessThan(card);
  });
});
