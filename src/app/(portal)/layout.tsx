import { requireUser } from "@/lib/current-user";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";
import { can } from "@/lib/auth/roles";
import { getSearchRecords } from "@/lib/search";
import { buildNavModel } from "@/lib/nav/model";
import { getShellData } from "@/lib/nav/shell-data";
import { getProductMenu } from "@/lib/products/switcher-data";
import { resolvedDisplayTimezone } from "@/lib/settings/timezone";
import { TimezoneProvider } from "@/app/(app)/_shell/timezone-context";
import { Shell } from "@/app/(app)/_shell/shell";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

// A person's own access (My access, requests, history, preferences): the same
// shell as the console, with the User menu. Someone who also runs the console
// gets the Admin / User switch at the foot of the sidebar.
async function PortalLayoutImpl({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const tz = await resolvedDisplayTimezone(user.id);
  const { counts, workspace } = await getShellData(user);
  const model = buildNavModel(user.role, counts);
  const records = can(user.role, "read_console") ? await getSearchRecords() : [];
  const products = await getProductMenu();
  return (
    <TimezoneProvider tz={tz}>
      <Shell
        model={model}
        view="user"
        records={records}
        role={user.role}
        products={products}
        workspace={workspace}
        user={{ name: user.name, email: user.email }}
        accountUrl={captivoAccountUrl()}
      >
        {children}
      </Shell>
    </TimezoneProvider>
  );
}

export default async function PortalLayout(...args: Parameters<typeof PortalLayoutImpl>) {
  return withRequestTenant(() => PortalLayoutImpl(...args));
}
