import { redirect } from "next/navigation";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";
import { requireUser } from "@/lib/current-user";
import { isPlatformAdmin } from "@/lib/platform/auth";
import { can } from "@/lib/auth/roles";
import { getSearchRecords } from "@/lib/search";
import { UpdateBanner } from "@/app/(app)/_shell/update-banner";
import { getUpdateCheckConfig } from "@/lib/updates/update-check-config";
import { managerVersion } from "@/lib/version";
import { isUpdateAvailable } from "@/lib/updates/semver";
import { buildNavModel } from "@/lib/nav/model";
import { getShellData } from "@/lib/nav/shell-data";
import { accountState } from "@/lib/auth/account-state";
import { getProductMenu } from "@/lib/products/switcher-data";
import { resolvedDisplayTimezone } from "@/lib/settings/timezone";
import { Shell } from "./_shell/shell";
import { TimezoneProvider } from "./_shell/timezone-context";
import { withRequestTenant } from "@/lib/tenant/request";
import { SupportBanner } from "./_shell/support-banner";
import { supportSessionInfo } from "@/lib/support/session";

// requireUser() must be read fresh from the DB on every request (session/role changes reflect immediately).
export const dynamic = "force-dynamic";

async function AppLayoutImpl({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Platform super-admins operate the platform console, not the tenant console —
  // send them there instead of the vendor "My access" view. Dormant on self-host
  // (no PLATFORM users exist there).
  if (isPlatformAdmin(user.role)) redirect("/platform");
  const tz = await resolvedDisplayTimezone(user.id);
  const support = await supportSessionInfo().catch(() => null);
  const showRead = can(user.role, "read_console");
  const showConfig = can(user.role, "configure");
  const searchRecords = showRead ? await getSearchRecords() : [];
  const mgr = managerVersion();
  const upd = showConfig ? await getUpdateCheckConfig() : null;
  const updateEnabled = upd?.enabled ?? false;
  const bannerLatest = upd && isUpdateAvailable(upd.latestVersion, mgr) ? upd.latestVersion : null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // eslint-disable-next-line react-hooks/purity
  const staleCheck = !!upd?.enabled && (upd.lastCheckedAt == null || Date.now() - upd.lastCheckedAt.getTime() > DAY_MS);

  const [{ counts, workspace }, account] = await Promise.all([getShellData(user), accountState(user.id)]);
  const model = buildNavModel(user.role, counts);
  // Awaited here rather than behind a <Suspense> boundary because the nav is a
  // client component and this arrives as a prop, so it has to resolve before
  // the nav renders. What protects the page is that the lookup is bounded
  // below a second and cannot throw -- see lib/products/center-picture.ts.
  const products = await getProductMenu();

  return (
    <TimezoneProvider tz={tz}>
      <Shell
        model={model}
        view="admin"
        records={searchRecords}
        role={user.role}
        products={products}
        workspace={workspace}
        user={{ name: user.name, email: user.email }}
        accountUrl={captivoAccountUrl()}
        account={account}
        banners={
          <>
            {support && <SupportBanner expiresAt={support.expiresAt.toISOString()} actorEmail={support.actorEmail} reason={support.reason} />}
            {showConfig && (
              <UpdateBanner
                enabled={updateEnabled}
                staleCheck={staleCheck}
                currentVersion={mgr}
                latestVersion={bannerLatest}
                latestUrl={upd?.latestUrl ?? null}
              />
            )}
          </>
        }
      >
        {children}
      </Shell>
    </TimezoneProvider>
  );
}

export default async function AppLayout(...args: Parameters<typeof AppLayoutImpl>) {
  return withRequestTenant(() => AppLayoutImpl(...args));
}
