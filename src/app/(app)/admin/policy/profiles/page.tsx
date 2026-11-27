import { requireCapability } from "@/lib/current-user";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { ProfilesView, type ListRow, type ProfileRow } from "./profiles-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profiles & lists" };

async function ProfilesPageImpl() {
  await requireCapability("configure");
  const [ws, profiles, lists, followers, attached] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.policyProfile.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } }),
    db.commandList.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { sites: true, profiles: true } } } }),
    db.site.findMany({ where: { policyProfileId: { not: null } }, select: { name: true, policyProfileId: true }, orderBy: { name: "asc" } }),
    db.site.findMany({ where: { commandListId: { not: null }, policyProfileId: null }, select: { commandListId: true } }),
  ]);
  const namesByProfile = new Map<string, string[]>();
  for (const f of followers) if (f.policyProfileId) namesByProfile.set(f.policyProfileId, [...(namesByProfile.get(f.policyProfileId) ?? []), f.name]);
  const directByList = new Map<string, number>();
  for (const a of attached) if (a.commandListId) directByList.set(a.commandListId, (directByList.get(a.commandListId) ?? 0) + 1);
  const listRows: ListRow[] = lists.map((l) => ({
    id: l.id, name: l.name, description: l.description, mode: l.mode === "allow" ? "allow" : "deny", entries: l.entries, resources: l._count.sites, profiles: l._count.profiles,
    direct: directByList.get(l.id) ?? 0,
  }));
  const profileRows: ProfileRow[] = profiles.map((p) => ({
    id: p.id, name: p.name, description: p.description, recordSessions: p.recordSessions, keystrokeLogging: p.keystrokeLogging,
    clipboardMode: p.clipboardMode, watermark: p.watermark, fileTransferMode: p.fileTransferMode, egressMode: p.egressMode, egressHosts: p.egressHosts,
    requireModerator: p.requireModerator, passwordCheckout: p.passwordCheckout, checkoutMaxMinutes: p.checkoutMaxMinutes, commandListId: p.commandListId, resources: p._count.sites,
    resourceNames: namesByProfile.get(p.id) ?? [],
  }));
  return (
    <main>
      <ProfilesView workspace={ws.slug} profiles={profileRows} lists={listRows} />
    </main>
  );
}

export default async function AdminProfilesPage(...args: Parameters<typeof ProfilesPageImpl>) {
  return withRequestTenant(() => ProfilesPageImpl(...args));
}
