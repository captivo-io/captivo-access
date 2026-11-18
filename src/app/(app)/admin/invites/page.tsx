import { redirect } from "next/navigation";
import { withRequestTenant } from "@/lib/tenant/request";

// Invites are a tab of the People page now; old links and bookmarks land there.
export default async function InvitesRedirect({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const sp = await searchParams;
  return withRequestTenant(async () => redirect(sp.new === "1" ? "/admin/users?tab=invites&new=1" : "/admin/users?tab=invites"));
}
