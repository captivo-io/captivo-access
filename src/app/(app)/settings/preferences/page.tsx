import { requireUser } from "@/lib/current-user";
import { withRequestTenant } from "@/lib/tenant/request";
import { PreferencesView } from "./preferences-view";
import { preferencesProps } from "./load";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences" };

async function PreferencesPageImpl() {
  const user = await requireUser();
  return <PreferencesView view="admin" {...await preferencesProps(user)} />;
}

export default async function PreferencesPage(...args: Parameters<typeof PreferencesPageImpl>) {
  return withRequestTenant(() => PreferencesPageImpl(...args));
}
