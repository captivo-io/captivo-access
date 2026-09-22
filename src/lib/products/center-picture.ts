import { cache } from "react";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import {
  fetchCenterPicture,
  isCentreConfigured,
  type CenterEntitlements,
} from "@/lib/auth/captivo-id-client";

/**
 * A wedged centre -- accepting connections, never answering -- must not add a
 * visible pause to every console page. The centre runs on the same host as the
 * cloud console, though the call still goes out through its public hostname and
 * TLS; a healthy reply is tens of milliseconds, so anything approaching a
 * second is already a fault rather than a slow day.
 *
 * Giving up early is cheap because the failure is silent by design: the
 * switcher does not render, and the next page load tries again.
 *
 * WHAT THIS DOES NOT BOUND: the tenant lookup that runs before it. A slow
 * database still delays this accessor, and no deadline here would change that
 * -- but it is the same exposure every other await in the console layout
 * already has, whereas a wedged centre is a dependency the console did not
 * have until this feature, which is why that one is bounded.
 */
const CENTER_TIMEOUT_MS = 900;

/**
 * What the centre knows about this tenant's organisation.
 *
 * ONE CALL PER REQUEST (React `cache`): the nav renders on every console page,
 * and a second consumer inside the same render would otherwise pay a second
 * timeout when the centre is wedged.
 *
 * The self-hosted gate is not REWRITTEN here: `isCentreConfigured` is the
 * centre client's own gate, exported, so there is still exactly one rule about
 * when a request may go out -- two gates guarding the same thing drift, and the
 * one that drifts is the one left open. What is decided here is only the ORDER.
 * Asking it first means a self-hosted console does not pay a tenant lookup on
 * every page render to learn something env already settled.
 *
 * Every failure path returns null, INCLUDING a thrown one: this is awaited from
 * the console layout, where an escaping exception blanks every page.
 */
export const getCenterPicture = cache(async (): Promise<CenterEntitlements | null> => {
  // Before the query, not after: on a self-hosted installation the centre is
  // never configured, so no answer this lookup could give would change the
  // outcome -- and the console's layout renders on every page.
  if (!isCentreConfigured()) return null;

  try {
    const tenant = await db.tenant.findUnique({
      where: { id: currentTenantId() },
      select: { captivoOrgId: true },
    });
    // No organisation means this workspace was not provisioned through the
    // centre -- every self-hosted one, and any cloud tenant created by hand.
    if (!tenant?.captivoOrgId) return null;

    const picture = await fetchCenterPicture(tenant.captivoOrgId, CENTER_TIMEOUT_MS);
    // `fetchCenterPicture` swallows its own failures and answers null, so a
    // misconfigured, refusing or wedged centre leaves no trace anywhere: the
    // menu simply does not render, which to an operator is indistinguishable
    // from the feature never having shipped. The organisation existed, so the
    // centre owed us an answer -- say which case this was.
    //
    // The silent behaviour is unchanged; only the trace is new.
    //
    // "Unconfigured" is deliberately NOT among the causes listed: the gate
    // above returned already in that case, so naming it here would send the
    // first person reading this line to check settings that cannot be the
    // problem.
    if (!picture) {
      console.warn(
        `[captivo-id] centre returned nothing for organisation ${tenant.captivoOrgId}` +
          " -- unreachable, refused, or an unusable body; the product switcher will not render",
      );
    }
    return picture;
  } catch (err) {
    console.warn("[captivo-id] centre lookup failed:", err);
    return null;
  }
});
