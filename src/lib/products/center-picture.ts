import { cache } from "react";
import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";
import { fetchCenterPicture, type CenterEntitlements } from "@/lib/auth/captivo-id-client";

/**
 * A wedged centre -- accepting connections, never answering -- must not add a
 * visible pause to every console page. The centre runs on the same host as the
 * cloud console, though the call still goes out through its public hostname and
 * TLS; a healthy reply is tens of milliseconds, so anything approaching a
 * second is already a fault rather than a slow day.
 *
 * Giving up early is cheap because the failure is silent by design: the
 * switcher does not render, and the next page load tries again.
 */
const CENTER_TIMEOUT_MS = 900;

/**
 * What the centre knows about this tenant's organisation.
 *
 * ONE CALL PER REQUEST (React `cache`): the nav renders on every console page,
 * and a second consumer inside the same render would otherwise pay a second
 * timeout when the centre is wedged.
 *
 * The self-hosted gate is NOT written here. `fetchCenterPicture` returns null
 * when `CAPTIVO_ID_ISSUER`/`CAPTIVO_ID_SERVICE_SECRET` are unset, which is
 * exactly the self-hosted case, and two gates guarding the same thing drift --
 * the one that drifts is the one left open.
 *
 * Every failure path returns null, INCLUDING a thrown one: this is awaited from
 * the console layout, where an escaping exception blanks every page.
 */
export const getCenterPicture = cache(async (): Promise<CenterEntitlements | null> => {
  try {
    const tenant = await db.tenant.findUnique({
      where: { id: currentTenantId() },
      select: { captivoOrgId: true },
    });
    // No organisation means this workspace was not provisioned through the
    // centre -- every self-hosted one, and any cloud tenant created by hand.
    if (!tenant?.captivoOrgId) return null;

    return await fetchCenterPicture(tenant.captivoOrgId, CENTER_TIMEOUT_MS);
  } catch (err) {
    console.warn("[captivo-id] centre lookup failed:", err);
    return null;
  }
});
