import { getCenterPicture } from "./center-picture";
import { productMenu, type ProductMenuItem } from "./product-menu";

/**
 * Where Captivo Portal lives. One host serves every Portal tenant, unlike an
 * Access console, so this is a constant rather than something the centre has to
 * tell us. The bridge's own `consoleOrigin` still wins when it is set.
 */
const PORTAL_URL = "https://app.captivo.io";

/**
 * Where someone goes to set Captivo Access up. Never reached from inside
 * Access -- ACCESS is `current` whenever it is entitled -- but the shared
 * decision function takes it, and passing the real address beats passing a
 * placeholder that would become a broken link if that ever changed.
 */
const ACCESS_SETUP_URL = "https://platform.cloud.captivo.io";

/**
 * The switcher's items for the signed-in tenant, or an empty list.
 *
 * `current` is always ACCESS here -- this code only ever runs inside Access.
 * The Portal repository passes "PORTAL" to the same function.
 */
export async function getProductMenu(): Promise<ProductMenuItem[]> {
  const data = await getCenterPicture();
  if (!data) return [];
  return productMenu(data, "ACCESS", { portal: PORTAL_URL, accessSetup: ACCESS_SETUP_URL });
}
