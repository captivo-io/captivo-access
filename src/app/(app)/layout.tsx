import { redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { isPlatformAdmin } from "@/lib/platform/auth";
import { can, ROLE_LABELS } from "@/lib/auth/roles";
import { countPendingGrants } from "@/lib/access/grants";
import { countUnreadNotifications } from "@/lib/notifications";
import { getSearchRecords } from "@/lib/search";
import { UpdateBanner } from "@/app/(app)/_shell/update-banner";
import { getUpdateCheckConfig } from "@/lib/updates/update-check-config";
import { managerVersion } from "@/lib/version";
import { isUpdateAvailable } from "@/lib/updates/semver";
import { buildNavModel } from "@/lib/nav/model";
import { getProductMenu } from "@/lib/products/switcher-data";
import { resolvedDisplayTimezone } from "@/lib/settings/timezone";
import { TopNav } from "./_shell/topnav";
import { TimezoneProvider } from "./_shell/timezone-context";
import { withRequestTenant } from "@/lib/tenant/request";
import { PlatformAnnouncement } from "@/components/platform-announcement";
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
  const showGrants = can(user.role, "approve_grants");
  const showRead = can(user.role, "read_console");
  const showConfig = can(user.role, "configure");
  const pending = showGrants ? await countPendingGrants() : 0;
  const unread = showRead ? await countUnreadNotifications() : 0;
  const searchRecords = showRead ? await getSearchRecords() : [];
  const mgr = managerVersion();
  const upd = showConfig ? await getUpdateCheckConfig() : null;
  const updateEnabled = upd?.enabled ?? false;
  const bannerLatest = upd && isUpdateAvailable(upd.latestVersion, mgr) ? upd.latestVersion : null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // eslint-disable-next-line react-hooks/purity
  const staleCheck = !!upd?.enabled && (upd.lastCheckedAt == null || Date.now() - upd.lastCheckedAt.getTime() > DAY_MS);

  const model = buildNavModel(user.role, { pending, unread });
  // Awaited here rather than behind a <Suspense> boundary because the nav is a
  // client component and this arrives as a prop, so it has to resolve before
  // the nav renders. What protects the page is that the lookup is bounded
  // below a second and cannot throw -- see lib/products/center-picture.ts.
  const products = await getProductMenu();

  return (
    <TimezoneProvider tz={tz}>
    <div className="app">
      <TopNav
        model={model}
        records={searchRecords}
        role={user.role}
        userName={user.name}
        roleLabel={ROLE_LABELS[user.role] ?? user.role}
        showLive={showRead}
        products={products}
      />
      <PlatformAnnouncement />
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
      <main className="content">{children}</main>
    </div>
    </TimezoneProvider>
  );
}

export default async function AppLayout(...args: Parameters<typeof AppLayoutImpl>) {
  return withRequestTenant(() => AppLayoutImpl(...args));
}

