import { db } from "@/lib/db";
import { getPlatformSettings } from "@/lib/settings/platform";
import { workspaceView } from "@/lib/mobile/views";
import { accountState } from "@/lib/auth/account-state";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";

/** What the Preferences tab shows, for the console and the portal alike. */
export async function preferencesProps(user: { id: string; email: string }) {
  const [u, s, ws, state] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { timezone: true, name: true, directoryManaged: true } }),
    getPlatformSettings(),
    workspaceView().catch(() => ({ slug: null as string | null })),
    accountState(user.id),
  ]);
  return {
    workspace: ws.slug,
    recoveryOn: state.recoveryOn,
    idLinked: state.idLinked,
    accountUrl: captivoAccountUrl(),
    email: user.email,
    name: u?.name ?? "",
    nameLocked: u?.directoryManaged ?? false,
    timezone: u?.timezone ?? "",
    orgTimezone: s.displayTimezone ?? null,
    serverNow: new Date().toISOString(),
  };
}
