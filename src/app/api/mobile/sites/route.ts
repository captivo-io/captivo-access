import { db } from "@/lib/db";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";

export const dynamic = "force-dynamic";

/** Every site with its last health probe, down ones first. */
export const GET = mobileRoute("read_console", async () => {
  const sites = await db.site.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, hostname: true, accessMode: true,
      probedAt: true, probeOk: true, probeDetail: true, probeLatencyMs: true,
      connector: { select: { name: true, status: true, lastSeenAt: true } },
    },
  });
  const rank = (ok: boolean | null) => (ok === false ? 0 : ok === null ? 1 : 2);
  sites.sort((a, b) => rank(a.probeOk) - rank(b.probeOk));
  return mobileJson({
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      hostname: s.hostname,
      accessMode: s.accessMode,
      probe: { ok: s.probeOk, at: s.probedAt?.toISOString() ?? null, detail: s.probeOk === false ? s.probeDetail : null, latencyMs: s.probeLatencyMs },
      connector: { name: s.connector.name, status: s.connector.status, lastSeenAt: s.connector.lastSeenAt?.toISOString() ?? null },
    })),
  });
});
