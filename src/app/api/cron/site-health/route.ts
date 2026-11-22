import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { probeSite, probeGatewaySite, type ProbeResult } from "@/lib/connector/health";
import { memberProbes, type MemberProbe } from "@/lib/connector/route";
import { classifyTransition, notifyTransition } from "@/lib/notifications";
import { recordCronRun } from "@/lib/cron/heartbeat";
import { forEachTenantId, inTenant } from "@/lib/cron/for-each-tenant";
import { reconcilePendingErasures } from "@/lib/connector/policy";
import { notifyPlatformAlerts } from "@/lib/platform/alert-push";
import { probeConnectors, recordConnectorEvent, writeConnectorSamples } from "@/lib/connector/history";
import { pumpTenant } from "@/lib/logforward/pump";
import { runRotationPass } from "@/lib/vault/rotation-pass";
import { planReconcileCopies, runReconcileCopies, saveReconcileCopies } from "@/lib/vault/reconcile-reshare";
import { planGroupReshare, runGroupReshare, saveGroupReshare } from "@/lib/vault/reshare";

// The group fields a resource is probed through (probeThrough below).
const groupProbeSelect = {
  probeByConnector: true,
  connectorGroup: { select: { members: { select: { connectorId: true, connector: { select: { status: true } } } } } },
} as const;

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
    const { sites, gateways, connectors } = await inTenant(tenantId, async () => ({
      connectors: await db.connector.findMany({ where: { status: { not: "REVOKED" } }, select: { id: true, tunnelSpark: true, hostAction: true } }),
      sites: await db.site.findMany({ select: { id: true, connectorId: true, upstreamUrl: true, name: true, probeOk: true, ...groupProbeSelect } }),
      // GATEWAY sites have no upstreamUrl; probe their remote-desktop target
      // (VaultCredential.targetHost:targetPort) with the same TCP connect.
      gateways: await db.site.findMany({
        where: { accessMode: { in: ["GATEWAY", "DATABASE"] } },
        select: {
          id: true,
          name: true,
          probeOk: true,
          connectorId: true,
          ...groupProbeSelect,
          vaultCredential: { select: { targetHost: true, targetPort: true } },
        },
      }),
    }));

    // Sites with no internal address aren't misconfigured probes — they're just
    // not set up yet. Skip them rather than reporting them "unreachable".
    const toProbe = sites.filter(
      (s): s is typeof s & { upstreamUrl: string } => !!s.upstreamUrl,
    );
    const gwToProbe = gateways.filter((g) => g.vaultCredential !== null);

    type Outcome = {
      id: string;
      connectorId: string;
      name: string;
      was: boolean | null;
      probeOk: boolean;
      probeDetail: string;
      probeLatencyMs: number | null;
      // A group resource: what each online member saw, and what it saw before.
      members?: Record<string, MemberProbe>;
      membersWas?: Record<string, MemberProbe>;
    };

    // A group resource is probed through every online member: it is reachable
    // when one member reaches it, and a member that cannot is left out of its
    // sessions (lib/connector/route.ts). Offline members are not probed.
    const probeThrough = async (
      site: { connectorId: string; connectorGroup: { members: { connectorId: string; connector: { status: string } }[] } | null; probeByConnector: unknown },
      probe: (connectorId: string) => Promise<ProbeResult>,
    ): Promise<Pick<Outcome, "connectorId" | "probeOk" | "probeDetail" | "probeLatencyMs" | "members" | "membersWas">> => {
      const online = site.connectorGroup?.members.filter((m) => m.connector.status === "ONLINE").map((m) => m.connectorId) ?? [];
      if (!site.connectorGroup || online.length === 0) return { connectorId: site.connectorId, ...(await probe(site.connectorId)) };
      const results = await Promise.all(online.map(async (id) => [id, await probe(id)] as const));
      const at = new Date().toISOString();
      const members = Object.fromEntries(results.map(([id, r]) => [id, { ok: r.probeOk, ms: r.probeLatencyMs, at, detail: r.probeOk ? null : r.probeDetail }]));
      const best = results.filter(([, r]) => r.probeOk).sort((a, b) => (a[1].probeLatencyMs ?? 0) - (b[1].probeLatencyMs ?? 0))[0];
      const [connectorId, r] = best ?? results[0];
      return { connectorId, probeOk: r.probeOk, probeDetail: r.probeDetail, probeLatencyMs: r.probeLatencyMs, members, membersWas: memberProbes(site.probeByConnector as never) };
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
      ...(await probeThrough(site, async (connectorId) => await probeSite({ connectorId, upstreamUrl: site.upstreamUrl }))),
    }));
    await runBatched(gwToProbe, async (site) => {
      const vc = site.vaultCredential!;
      return {
        id: site.id,
        name: site.name,
        was: site.probeOk,
        ...(await probeThrough(site, async (connectorId) => await probeGatewaySite({ connectorId, targetHost: vc.targetHost, targetPort: vc.targetPort }))),
      };
    });

    // Each connector's tunnel and load: the 30-day strip and the spark.
    const tunnels = connectors.length ? await probeConnectors(connectors.map((c) => c.id)) : null;

    // 3. WRITE -- scoped, DB only, one short transaction for the whole pass.
    const now = new Date();
    await inTenant(tenantId, async () => {
      for (const o of outcomes) {
        await db.site.update({
          where: { id: o.id },
          data: { probedAt: now, probeOk: o.probeOk, probeDetail: o.probeDetail, probeLatencyMs: o.probeLatencyMs, ...(o.members ? { probeByConnector: o.members } : {}) },
        });
      }
      if (tunnels) await writeConnectorSamples(connectors, tunnels, now);
    });

    // 4. NOTIFY -- after the results are safely written, and one scope EACH.
    // notifyTransition inserts a row (needs the tenant) and also fires a webhook
    // and sends mail (does not). Giving each its own short scope means a slow mail
    // can cost at most its own notification, never a health result; a thrown one
    // cannot end the pass either.
    for (const o of outcomes) {
      // A group member that stopped (or started again) reaching the resource,
      // while the resource as a whole may still be up: said on that member.
      for (const [cid, p] of Object.entries(o.members ?? {})) {
        const before = o.membersWas?.[cid]?.ok;
        if (before === undefined || before === p.ok) continue;
        await inTenant(tenantId, () =>
          recordConnectorEvent(cid, p.ok ? "ok" : "bad", p.ok ? `Reaches ${o.name} again` : `Cannot reach ${o.name}; its sessions go through other group members`),
        ).catch(() => {});
      }
      const transition = classifyTransition(o.was, o.probeOk);
      if (!transition) continue;
      await inTenant(tenantId, () =>
        transition === "site_down"
          ? recordConnectorEvent(o.connectorId, "bad", `Target unreachable: ${o.name}`)
          : recordConnectorEvent(o.connectorId, "ok", `Target reachable again: ${o.name}`),
      ).catch(() => {});
      // Only a down event carries a failure reason; a recovered event has no
      // meaningful detail (probeDetail is just "reachable" on success).
      const detail = transition === "site_down" ? o.probeDetail : null;
      try {
        await inTenant(tenantId, () => notifyTransition({ type: transition, siteId: o.id, siteName: o.name, detail }));
      } catch {
        // Best-effort, as before: a failed notification never breaks the cron.
      }
    }

    // 5. RECONCILE erasures — re-push pending deletions to their connectors so an
    // offline-at-delete connector still erases on a later pass. Own scope; never
    // breaks the health pass.
    try {
      await inTenant(tenantId, () => reconcilePendingErasures());
    } catch {
      /* best-effort */
    }

    // 6. GROUP SECRETS -- a member that has no copy of a saved password yet (it
    // joined later, or the member that had one was offline) gets one from a
    // member that has it. Plan and save scoped, the copying unscoped.
    try {
      const plan = await inTenant(tenantId, () => planGroupReshare());
      if (plan.length) {
        const copied = await runGroupReshare(plan);
        await inTenant(tenantId, () => saveGroupReshare(plan, copied, null));
      }
      // The reconcile accounts of password rotation, the same way.
      const rplan = await inTenant(tenantId, () => planReconcileCopies());
      if (rplan.length) {
        const got = await runReconcileCopies(rplan);
        await inTenant(tenantId, () => saveReconcileCopies(rplan, got));
      }
    } catch (e) {
      console.error("vault: copying secrets to group members failed", e);
    }

    // 7. LOG FORWARDING -- whatever a restart or a failed delivery left behind
    // (new records start their own pump). Not awaited: a slow SIEM must not hold
    // the health pass.
    void pumpTenant(tenantId).catch((e) => console.error("log forwarding: catch-up failed", e));

    // 8. PASSWORD ROTATION -- due rotations, retries and daily checks
    // (lib/vault/rotation.ts). Not awaited: a change takes seconds per resource.
    void runRotationPass(tenantId).catch((e) => console.error("vault: rotation pass failed", e));

    return {
      checked: toProbe.length + gwToProbe.length,
      reachable: outcomes.filter((o) => o.probeOk).length,
      unreachable: outcomes.filter((o) => !o.probeOk).length,
      skipped: sites.length - toProbe.length - gwToProbe.length,
    };
  });

  // The pass just refreshed what the platform's alerts are made of; new ones
  // reach the operators' phones. No-op on self-host; never throws.
  await notifyPlatformAlerts();

  // Self-host (exactly one, implicit-default result): the historical top-level
  // { checked, reachable, unreachable, skipped } shape, unchanged. Multi-tenant
  // fan-out: a per-tenant breakdown.
  return NextResponse.json(results.length === 1 ? results[0] : { results });
}
