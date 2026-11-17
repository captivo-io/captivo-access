import { requireUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { TimezoneForm } from "@/app/(app)/settings/preferences/timezone-form";
import { NameForm } from "@/app/(app)/settings/preferences/name-form";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences" };

// Vendor-facing counterpart of /settings/preferences: lets a portal user pick the
// timezone their access windows, requests and history are shown (and entered) in.
async function PreferencesPageImpl() {
  const user = await requireUser();
  const u = await db.user.findUnique({ where: { id: user.id }, select: { timezone: true, name: true, directoryManaged: true } });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Preferences</h1>
          <p>Your personal display settings for this account.</p>
        </div>
      </div>
      <div className="card">
        <h2 style={{ fontSize: "1rem", margin: 0 }}>Your name</h2>
        <p className="cell-sub" style={{ margin: 0 }}>How you&apos;re greeted and shown to the admins who approve your access.</p>
        <NameForm initial={u?.name ?? ""} locked={u?.directoryManaged ?? false} />
      </div>
      <div className="card">
        <h2 style={{ fontSize: "1rem", margin: 0 }}>Display timezone</h2>
        <p className="cell-sub" style={{ margin: 0 }}>
          Dates and times you see — and the times you type when requesting access — use this timezone.
          Leave on the organization default to follow the setting chosen by your administrator.
        </p>
        <TimezoneForm initial={u?.timezone ?? ""} />
      </div>
    </div>
  );
}

export default async function PreferencesPage(...args: Parameters<typeof PreferencesPageImpl>) {
  return withRequestTenant(() => PreferencesPageImpl(...args));
}
