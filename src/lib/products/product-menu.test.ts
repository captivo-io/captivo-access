import { describe, it, expect } from "vitest";
import { productMenu } from "./product-menu";
import type { CenterEntitlements } from "@/lib/auth/captivo-id-client";

const NOW = new Date("2026-09-22T12:00:00Z");
const HREFS = { portal: "https://app.captivo.io", accessSetup: "https://platform.cloud.captivo.io" };

// A bridge address must never equal the fallback it is meant to beat. When the
// two match, "the bridge's address wins" and "the fallback is used" produce the
// same menu, and every assertion about that rule passes either way -- which is
// exactly how this suite once stayed green with the rule deleted.
const BRIDGED_PORTAL = "https://portal.example.test";

const ent = (product: string, expiresAt: string | null = null) => ({
  product, plan: "free", limits: null, expiresAt,
});
const link = (product: string, consoleOrigin: string | null = null) => ({
  product, tenantId: "t_" + product, consoleOrigin,
});
const data = (entitlements: CenterEntitlements["entitlements"], links: CenterEntitlements["links"] = []) =>
  ({ entitlements, links }) as CenterEntitlements;

describe("productMenu", () => {
  it("marks the product you are on as current and gives it no address", () => {
    const menu = productMenu(data([ent("PORTAL"), ent("ACCESS")]), "ACCESS", HREFS, NOW);
    expect(menu[1]).toEqual({ product: "ACCESS", state: "current", href: "" });
  });

  it("sends an already set up product to its own console", () => {
    // Access console hosts are per tenant; Portal's one host serves every
    // tenant, so only the bridge can say where the other product lives.
    const menu = productMenu(
      data([ent("PORTAL"), ent("ACCESS")], [link("PORTAL", BRIDGED_PORTAL)]),
      "ACCESS", HREFS, NOW,
    );
    expect(menu[0]).toEqual({ product: "PORTAL", state: "open", href: BRIDGED_PORTAL });
    expect(menu[0].href).not.toBe(HREFS.portal);
  });

  it("offers setup for an entitled product that is not set up", () => {
    const menu = productMenu(data([ent("PORTAL"), ent("ACCESS")]), "ACCESS", HREFS, NOW);
    expect(menu[0]).toEqual({ product: "PORTAL", state: "setup", href: HREFS.portal });
  });

  it("keeps a bridged product whose console origin was never recorded", () => {
    // Portal registers no origin by design. Dropping the item would strand
    // someone from a product they actually have.
    const menu = productMenu(data([ent("PORTAL"), ent("ACCESS")], [link("PORTAL", null)]), "ACCESS", HREFS, NOW);
    expect(menu[0]).toEqual({ product: "PORTAL", state: "open", href: HREFS.portal });
  });

  it("leaves out a product the organisation is not entitled to", () => {
    // Showing someone a product they cannot have is worse than saying nothing.
    const menu = productMenu(data([ent("ACCESS")]), "PORTAL", HREFS, NOW);
    expect(menu.some((m) => m.product === "PORTAL")).toBe(false);
  });

  it("renders no menu when there is nothing to switch to", () => {
    // A single-option menu is noise.
    expect(productMenu(data([ent("ACCESS")]), "ACCESS", HREFS, NOW)).toEqual([]);
  });

  it("leaves out an expired entitlement", () => {
    // Expire the product the viewer is ON, not the other one: with only one
    // other item left, the menu still renders (it is not a collapse case),
    // so the assertion below is provably about the expiry rule and nothing
    // else -- an empty array would have been true for the wrong reason.
    const menu = productMenu(
      data([ent("ACCESS", "2026-09-01T00:00:00.000Z"), ent("PORTAL")]), "ACCESS", HREFS, NOW,
    );
    expect(menu).toEqual([{ product: "PORTAL", state: "setup", href: HREFS.portal }]);
  });

  it("keeps an entitlement that expires in the future", () => {
    const menu = productMenu(
      data([ent("PORTAL", "2027-01-01T00:00:00.000Z"), ent("ACCESS")]), "ACCESS", HREFS, NOW,
    );
    expect(menu.map((m) => m.product)).toEqual(["PORTAL", "ACCESS"]);
  });

  it("treats an unparseable expiry as expired", () => {
    // Unknown is not valid. As above, expire the viewer's own product so the
    // surviving menu is non-empty and the assertion is about absence, not
    // about the collapse rule getting there first.
    const menu = productMenu(data([ent("ACCESS", "not-a-date"), ent("PORTAL")]), "ACCESS", HREFS, NOW);
    expect(menu).toEqual([{ product: "PORTAL", state: "setup", href: HREFS.portal }]);
  });

  it("still shows the way out when your own entitlement has lapsed", () => {
    // An entitlement can lapse while someone is signed in. The surviving item
    // is a real destination and must not be collapsed away.
    const menu = productMenu(
      data([ent("PORTAL")], [link("PORTAL", BRIDGED_PORTAL)]), "ACCESS", HREFS, NOW,
    );
    expect(menu).toEqual([{ product: "PORTAL", state: "open", href: BRIDGED_PORTAL }]);
  });

  it("does not let one product's bridge mark another as set up", () => {
    const menu = productMenu(data([ent("PORTAL"), ent("ACCESS")], [link("ACCESS", null)]), "ACCESS", HREFS, NOW);
    expect(menu[0].state).toBe("setup");
  });

  it("orders the menu the same way whatever the centre returns", () => {
    // An order that followed the centre's would move under the reader between
    // page loads.
    const menu = productMenu(data([ent("ACCESS"), ent("PORTAL")]), "ACCESS", HREFS, NOW);
    expect(menu.map((m) => m.product)).toEqual(["PORTAL", "ACCESS"]);
  });

  it("reads a bridge's own address on the ACCESS row too, not just on Portal's", () => {
    // The mirror's whole point is per-tenant Access consoles, and every other
    // case here leaves ACCESS as `current`, which carries no address at all.
    // Without this, a change that read the bridge only on the PORTAL row would
    // pass the whole file while sending every Access customer to the generic
    // setup page instead of their own console.
    const menu = productMenu(
      data([ent("PORTAL"), ent("ACCESS")], [link("ACCESS", "https://acme.cloud.captivo.io")]),
      "PORTAL", HREFS, NOW,
    );
    expect(menu[1]).toEqual({ product: "ACCESS", state: "open", href: "https://acme.cloud.captivo.io" });
  });

  it("looks from Portal's side too: marks it current and offers Access setup", () => {
    // Every other case in this file passes current: "ACCESS". That leaves
    // `product === current` exercised only against the ACCESS row, and
    // hrefs.accessSetup never read at all -- both gaps the Portal suite does
    // not have. Looking from Portal's side closes them: it asserts the full
    // shape of both items, so a broken `current` comparison or a collapsed
    // fallback ternary both show up here.
    const menu = productMenu(data([ent("PORTAL"), ent("ACCESS")]), "PORTAL", HREFS, NOW);
    expect(menu).toEqual([
      { product: "PORTAL", state: "current", href: "" },
      { product: "ACCESS", state: "setup", href: HREFS.accessSetup },
    ]);
  });
});
