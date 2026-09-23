import { redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { reportLastProduct } from "@/lib/auth/captivo-id-client";
import { getProductMenu } from "@/lib/products/switcher-data";
import { withRequestTenant } from "@/lib/tenant/request";

/**
 * Leaving for the other product, and saying so.
 *
 * Captivo remembers which product a person last entered so a sign-in with no
 * product intent lands where they work. Using the switcher is that same
 * statement -- "I want to be there now" -- but it is plain navigation to
 * another host, which this product would otherwise never see. Without this
 * hop, someone who switched to Portal and worked there was sent back to
 * Access at their next sign-in. That is the friction the whole feature exists
 * to remove, pointing the other way.
 *
 * The destination is resolved HERE, from the switcher's own data. It is never
 * carried in the query string: this route is reached while signed in, and a
 * redirect to a caller-supplied address would be an open redirect.
 */
export const dynamic = "force-dynamic";

async function GoPageImpl() {
  const user = await requireUser();

  const portal = (await getProductMenu()).find((item) => item.product === "PORTAL");
  if (!portal?.href) redirect("/");

  // Recorded before leaving: the browser is about to be handed to another
  // host and this route will not run again. Awaited rather than dangling --
  // an unawaited promise can be killed when the response completes.
  if (user.email) await reportLastProduct(user.email, "PORTAL");

  redirect(portal.href);
}

// Wrapped like every other RSC entry point: getProductMenu reads the tenant
// through currentTenantId(), which is the async-local scope and NOT the db
// proxy's per-query auto-scope. Unwrapped it answers "default" on every host,
// so this page would find no Portal item and the switcher would silently do
// nothing. The repo's entry-point guard caught this before it shipped.
export default async function GoPage() {
  return withRequestTenant(() => GoPageImpl());
}
