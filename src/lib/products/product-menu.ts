import type { CenterEntitlements } from "@/lib/auth/captivo-id-client";

/**
 * MIRRORS apps/web/src/lib/products/product-menu.ts IN THE CAPTIVO PORTAL
 * REPOSITORY. The two bodies are identical below the import line and must stay
 * that way; a rule changed here has to be changed there.
 *
 * What deliberately differs, and nothing else may:
 *  - the import above (each repository has its own centre client);
 *  - the test file's language (this repository is English-only, Portal's tests
 *    are Turkish), so the two suites are the same CASES, not the same text.
 *
 * `hrefs.accessSetup` is never read in this copy -- ACCESS is `current`
 * whenever it is entitled, and absent when it is not. The parameter stays so
 * the two copies remain comparable line for line.
 */

export type ProductCode = "PORTAL" | "ACCESS";

/**
 * `current` — the product you are on; not clickable.
 * `open`    — entitled and already set up; goes to its console.
 * `setup`   — entitled but not set up yet; goes to the setup flow.
 */
export type ProductState = "current" | "open" | "setup";

export interface ProductMenuItem {
  product: ProductCode;
  state: ProductState;
  /** Empty for the current product, which is not a link. */
  href: string;
}

/** Fixed, so the menu does not reorder itself between page loads. */
const ORDER: ProductCode[] = ["PORTAL", "ACCESS"];

function isLive(expiresAt: string | null | undefined, now: Date): boolean {
  if (!expiresAt) return true;
  const at = new Date(expiresAt).getTime();
  // An unparseable date yields NaN, and every NaN comparison is false -- which
  // with THIS polarity (`at > now` means live) already answers "not live". The
  // guard is therefore explicit rather than load-bearing here, and removing it
  // changes nothing today. It stays because the rule it states -- unknown is
  // not valid -- must survive someone inverting the comparison later: picture
  // a sibling helper written so that `<=` means expired instead of `>` meaning
  // live -- there, without the guard, NaN would read as "never expires". Same
  // rule, opposite code.
  if (Number.isNaN(at)) return false;
  return at > now.getTime();
}

/**
 * Which products to show in the switcher, and where each one goes.
 *
 * A product the organisation is NOT entitled to is absent, not greyed out:
 * showing someone a product they cannot have is worse than saying nothing.
 *
 * NOTHING TO SWITCH TO MEANS NO MENU: the switcher exists to take you
 * somewhere else, so it renders only when at least one item is not the
 * product you are already on -- not simply "when there is more than one
 * item". Those two differ when your OWN product's entitlement has lapsed
 * while you are still signed in: `current` then has no item at all (its
 * entitlement check fails like anyone else's), and the single item left is
 * someone else's product, not a leftover -- it is exactly the route out, and
 * must still render.
 *
 * A bridge with no `consoleOrigin` still counts as OPEN, not SETUP, and falls
 * back to the plain product address instead: a null origin there means "one
 * host serves every tenant" (true for Portal) or "the platform host will
 * route this signed-in person to their own console anyway" (true for
 * Access's setup address) -- either way it is a valid destination, not a
 * missing one.
 *
 * THIS FUNCTION IS DUPLICATED ACROSS THE TWO CAPTIVO REPOSITORIES, Portal and
 * Access. The two copies must give the same answer, and the two suites must
 * cover the same CASES -- not the same text: the Access repository is
 * English-only, so its test names read differently on purpose. There is no shared package between the two, so
 * covering the same cases is the whole defence against drift. If you change a
 * rule here, change it there.
 */
export function productMenu(
  data: CenterEntitlements,
  current: ProductCode,
  hrefs: { portal: string; accessSetup: string },
  now: Date = new Date(),
): ProductMenuItem[] {
  const items: ProductMenuItem[] = [];

  for (const product of ORDER) {
    const entitlement = data.entitlements.find((e) => e.product === product);
    if (!entitlement || !isLive(entitlement.expiresAt, now)) continue;

    if (product === current) {
      items.push({ product, state: "current", href: "" });
      continue;
    }

    // The product filter matters: a Portal bridge says nothing about whether
    // Access is set up, and treating any bridge as "set up" would point every
    // link at the wrong product.
    const bridge = data.links.find((l) => l.product === product);
    const fallback = product === "PORTAL" ? hrefs.portal : hrefs.accessSetup;
    items.push({
      product,
      state: bridge ? "open" : "setup",
      href: bridge?.consoleOrigin ?? fallback,
    });
  }

  return items.some((item) => item.state !== "current") ? items : [];
}
