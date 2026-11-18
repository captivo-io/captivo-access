import { requireUser } from "@/lib/current-user";
import { withRequestTenant } from "@/lib/tenant/request";
import { PreferencesView } from "@/app/(app)/settings/preferences/preferences-view";
import { preferencesProps } from "@/app/(app)/settings/preferences/load";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences" };

// The portal's Preferences: the same tab as /settings/preferences, in the user
// view, so a portal user picks the time zone their access windows, requests and
// history are shown (and entered) in.
async function PreferencesPageImpl() {
  const user = await requireUser();
  return <PreferencesView view="user" {...await preferencesProps(user)} />;
}

export default async function PreferencesPage(...args: Parameters<typeof PreferencesPageImpl>) {
  return withRequestTenant(() => PreferencesPageImpl(...args));
}
