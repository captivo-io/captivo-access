import Link from "next/link";
import { requireCapability } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { withRequestTenant } from "@/lib/tenant/request";
import { ReviewView, type ReviewItemVM } from "./review-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Access review" };

async function ReviewPageImpl({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCapability("read_console");
  const { id } = await params;
  const r = await db.accessReview.findUnique({ where: { id }, include: { items: { orderBy: [{ siteName: "asc" }, { userLabel: "asc" }] } } });
  if (!r) {
    return (
      <main>
        <Link href="/admin/reviews" className="btn sm rc-back">← Access reviews</Link>
        <div className="au-empty" style={{ marginTop: 16 }}><b>Review not found</b><span className="cell-sub">It may be in another workspace.</span></div>
      </main>
    );
  }
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const items: ReviewItemVM[] = r.items.map((i) => ({
    id: i.id, userId: i.userId, userLabel: i.userLabel, userEmail: i.userEmail, userRole: i.userRole, siteName: i.siteName,
    grantCreatedAt: i.grantCreatedAt.toISOString(), grantedBy: i.grantedBy, grantEndsAt: iso(i.grantEndsAt), scheduled: i.scheduled,
    directoryManaged: i.directoryManaged, lastUsedAt: iso(i.lastUsedAt), decision: i.decision, limitTo: iso(i.limitTo),
    decidedByLabel: i.decidedByLabel, decidedAt: iso(i.decidedAt), outcome: i.outcome,
  }));
  return (
    <main>
      <ReviewView
        review={{
          id: r.id, name: r.name, status: r.status, dueAt: iso(r.dueAt), openedAt: iso(r.openedAt), opensAt: r.opensAt.toISOString(), closedAt: iso(r.closedAt),
          onNoAnswer: r.onNoAnswer, recurrence: r.recurrence, scope: r.siteIds.length ? `${r.siteIds.length} resource${r.siteIds.length === 1 ? "" : "s"}` : "All resources",
        }}
        items={items}
        me={user.id}
        canReview={can(user.role, "approve_grants")}
      />
    </main>
  );
}

export default async function ReviewPage(...args: Parameters<typeof ReviewPageImpl>) {
  return withRequestTenant(() => ReviewPageImpl(...args));
}
