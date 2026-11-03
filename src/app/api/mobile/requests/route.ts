import { listPendingGrants } from "@/lib/access/grants";
import { db } from "@/lib/db";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";

export const dynamic = "force-dynamic";

/** Pending access requests, oldest first -- the same list the console shows. */
export const GET = mobileRoute("read_console", async () => {
  const pending = await listPendingGrants();
  const ids = pending.map((g) => g.id);
  // listPendingGrants selects for the console's table; the app also shows the
  // vendor's company, which a phone screen has room for and a table did not.
  const companies = ids.length
    ? new Map((await db.accessGrant.findMany({ where: { id: { in: ids } }, select: { id: true, user: { select: { company: true } } } })).map((g) => [g.id, g.user.company]))
    : new Map<string, string | null>();
  return mobileJson({
    requests: pending.map((g) => ({
      id: g.id,
      createdAt: g.createdAt.toISOString(),
      startsAt: g.startsAt?.toISOString() ?? null,
      endsAt: g.endsAt?.toISOString() ?? null,
      note: g.note,
      scheduled: !!g.schedule,
      vendor: { name: g.user.name, email: g.user.email, company: companies.get(g.id) ?? null },
      site: { name: g.site.name, hostname: g.site.hostname },
    })),
  });
});
