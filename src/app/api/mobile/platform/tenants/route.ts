import { platformSnapshot } from "@/lib/platform/overview";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";
import { tenantView } from "@/lib/mobile/platform";

export const dynamic = "force-dynamic";

/** Every workspace with its numbers and problems; ones with problems first, deleted last. */
export const GET = mobileRoute("manage_tenants", async () => {
  const { tenants } = await platformSnapshot();
  const rank = (t: ReturnType<typeof tenantView>) => (t.status === "DELETED" ? 3 : t.problems.length ? 0 : t.status === "SUSPENDED" ? 2 : 1);
  const rows = tenants.map(tenantView).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return mobileJson({ tenants: rows });
});
