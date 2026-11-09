import { recentActivity } from "@/lib/platform/overview";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";

export const dynamic = "force-dynamic";

/** The latest admin actions and access decisions across every workspace, newest first. */
export const GET = mobileRoute("manage_tenants", async () => {
  const { admin, access } = await recentActivity(30);
  const events = [
    ...admin.map((e) => ({ id: `a-${e.id}`, kind: "admin" as const, at: new Date(e.timestamp).toISOString(), slug: e.slug, actor: e.actorEmail, text: e.summary })),
    ...access.map((e) => ({
      id: `x-${e.id}`, kind: "access" as const, at: new Date(e.timestamp).toISOString(), slug: e.slug, actor: e.userEmail,
      text: `${e.decision.toLowerCase()} · ${e.siteName ?? e.host}${e.reason ? ` · ${e.reason}` : ""}`, decision: e.decision,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  return mobileJson({ events });
});
