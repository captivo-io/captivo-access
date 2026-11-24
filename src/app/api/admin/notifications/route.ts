import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { withTenantRoute } from "@/lib/tenant/request";
import { listPendingGrants } from "@/lib/access/grants";
import { canModerate } from "@/lib/moderation/rules";
import { waitingRequests } from "@/lib/moderation/requests";
import { resolvedModeratorRoles } from "@/lib/settings/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "read_console")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Waiting access requests lead the panel for those who decide them; they
  // leave it on their own once approved or denied, so they aren't marked read.
  const moderator = canModerate(user.role, await resolvedModeratorRoles());
  const [rows, unread, pending, moderation] = await Promise.all([
    db.notification.findMany({
      where: { readAt: null },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, type: true, siteName: true, detail: true, createdAt: true },
    }),
    db.notification.count({ where: { readAt: null } }),
    can(user.role, "approve_grants") ? listPendingGrants() : Promise.resolve([]),
    moderator ? waitingRequests().then((w) => w.filter((r) => r.userId !== user.id)) : Promise.resolve([]),
  ]);

  return NextResponse.json({
    items: rows.map((n) => ({ id: n.id, type: n.type, siteName: n.siteName ?? "—", detail: n.detail, when: timeAgo(n.createdAt) })),
    unread,
    requests: pending.slice().reverse().slice(0, 5).map((g) => ({ id: g.id, who: g.user.name || g.user.email, siteName: g.site.name, when: timeAgo(g.createdAt) })),
    requestCount: pending.length,
    // Sessions waiting for a moderator lead it, for those who may moderate.
    moderation: moderation.slice(0, 5).map((r) => ({ id: r.id, who: r.userName, siteName: r.siteName, when: timeAgo(new Date(r.requestedAt)) })),
  });
});
