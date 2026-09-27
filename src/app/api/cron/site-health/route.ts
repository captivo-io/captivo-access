import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { probeSite, probeGatewaySite } from "@/lib/connector/health";
import { classifyTransition, notifyTransition } from "@/lib/notifications";
import { recordCronRun } from "@/lib/cron/heartbeat";
import { forEachTenantId, inTenant } from "@/lib/cron/for-each-tenant";

function cronAuthorized(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("authorization"), `Bearer ${s}`);
}

const POOL = 8;

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The probes themselves are network calls, not DB reads — tenant-agnostic.
  // But the site list (findMany) and the result writes (site.update) are RLS
  // -scoped, so each tenant's site list + writes run inside its own scope
  // (fanned out via forEachTenant): simplest correct option, and a tenant's
  // site count is small enough that per-tenant probing costs nothing extra a
  // single global pass wouldn't have paid anyway.
  const results = await forEachTenantId(async (tenantId) => {
    // Stamped INSIDE the tenant scope, deliberately. CronRun is a per-tenant table
    // behind RLS, so an upsert from outside a scope is rejected by the row policy
    // and swallowed by the best-effort catch: the heartbeat simply never landed in
    // cloud mode. Since cronHealth() treats site-health as the scheduler's pulse,
    // every tenant's console showed "Background jobs haven't run yet." while the
    // jobs were in fact running -- and the real stale-job warning could never fire,
    // because that branch is only reached once the pulse is healthy.
    await inTenant(tenantId, () => recordCronRun("site-health"));

    // THREE PHASES, and the split is the fix, not a tidy-up.
    //
    // This job used to run whole inside forEachTenant, which establishes the
    // tenant by opening a transaction and holding it for the callback. Prisma's
    // interactive-transaction timeout is 5 s, and the callback probed every site
    // over the network inside it -- so a slow target did not merely get marked
    // unreachable: it expired the transaction and the WHOLE pass's results went
    // unwritten (P2028, measured at 6252 ms). Reads and writes are scoped; the
    // probing, the webhooks and the mail are not.

    // 1. READ -- scoped, DB only.
    const { sites, gateways } = await inTenant(tenantId, async () => ({
      sites: await db.site.findMany({ select: { id: true, connectorId: true, upstreamUrl: true, name: true, probeOk: true } }),
      // GATEWAY sites have no upstreamUrl; probe their remote-desktop target
      // (VaultCredential.targetHost:targetPort) with the same TCP connect.
      gateways: await db.site.findMany({
        where: { accessMode: "GATEWAY" },
        select: {
          id: true,
          name: true,
          probeOk: true,
          connectorId: true,
          vaultCredential: { select: { targetHost: true, targetPort: true } },
        },
      }),
    }));

    // Sites with no internal address aren't misconfigured probes — they're just
    // not set up yet. Skip them rather than reporting them "unreachable".
    const toProbe = sites.filter(
      (s): s is { id: string; connectorId: string; upstreamUrl: string; name: string; probeOk: boolean | null } => !!s.upstreamUrl,
    );
    const gwToProbe = gateways.filter((g) => g.vaultCredential !== null);

    type Outcome = {
      id: string;
      name: string;
      was: boolean | null;
      probeOk: boolean;
      probeDetail: string;
      probeLatencyMs: number | null;
    };

    // 2. PROBE -- UNSCOPED. Network only: no transaction is open, so a target that
    // takes a minute to time out costs only its own latency.
    const outcomes: Outcome[] = [];
    const runBatched = async <S>(items: S[], probe: (s: S) => Promise<Outcome>) => {
      // Bounded concurrency so a large site list stays fast without hammering.
      for (let i = 0; i < items.length; i += POOL) {
        outcomes.push(...(await Promise.all(items.slice(i, i + POOL).map(probe))));
      }
    };
    await runBatched(toProbe, async (site) => ({
      id: site.id,
      name: site.name,
      was: site.probeOk,
      ...(await probeSite(site)),
    }));
    await runBatched(gwToProbe, async (site) => {
      const vc = site.vaultCredential!;
      return {
        id: site.id,
        name: site.name,
        was: site.probeOk,
        ...(await probeGatewaySite({ connectorId: site.connectorId, targetHost: vc.targetHost, targetPort: vc.targetPort })),
      };
    });

    // 3. WRITE -- scoped, DB only, one short transaction for the whole pass.
    const now = new Date();
    await inTenant(tenantId, async () => {
      for (const o of outcomes) {
        await db.site.update({
          where: { id: o.id },
          data: { probedAt: now, probeOk: o.probeOk, probeDetail: o.probeDetail, probeLatencyMs: o.probeLatencyMs },
        });
      }
    });

    // 4. NOTIFY -- after the results are safely written, and one scope EACH.
    // notifyTransition inserts a row (needs the tenant) and also fires a webhook
    // and sends mail (does not). Giving each its own short scope means a slow mail
    // can cost at most its own notification, never a health result; a thrown one
    // cannot end the pass either.
    for (const o of outcomes) {
      const transition = classifyTransition(o.was, o.probeOk);
      if (!transition) continue;
      // Only a down event carries a failure reason; a recovered event has no
      // meaningful detail (probeDetail is just "reachable" on success).
      const detail = transition === "site_down" ? o.probeDetail : null;
      try {
        await inTenant(tenantId, () => notifyTransition({ type: transition, siteId: o.id, siteName: o.name, detail }));
      } catch {
        // Best-effort, as before: a failed notification never breaks the cron.
      }
    }

    return {
      checked: toProbe.length + gwToProbe.length,
      reachable: outcomes.filter((o) => o.probeOk).length,
      unreachable: outcomes.filter((o) => !o.probeOk).length,
      skipped: sites.length - toProbe.length - gwToProbe.length,
    };
  });

  // Self-host (exactly one, implicit-default result): the historical top-level
  // { checked, reachable, unreachable, skipped } shape, unchanged. Multi-tenant
  // fan-out: a per-tenant breakdown.
  return NextResponse.json(results.length === 1 ? results[0] : { results });
}
