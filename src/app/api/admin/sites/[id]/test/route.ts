import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { proxyThroughConnector } from "@/lib/connector/dataplane";
import { probeSite, probeGatewaySite } from "@/lib/connector/health";
import { classifyTransition, notifyTransition } from "@/lib/notifications";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

export const POST = withTenantRoute(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const site = await db.site.findUnique({
    where: { id },
    select: {
      name: true,
      connectorId: true,
      upstreamUrl: true,
      insecureSkipVerify: true,
      probeOk: true,
      accessMode: true,
      vaultCredential: { select: { targetHost: true, targetPort: true } },
      connector: { select: { status: true } },
    },
  });
  if (!site) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (site.connector.status === "REVOKED") {
    // Guards the race between a revoke and the /kick call landing on the
    // data-plane: even if the connector's yamux session is still briefly
    // alive, never proxy to a connector we've already revoked.
    return NextResponse.json({ error: "connector_revoked" });
  }
  if (site.accessMode === "GATEWAY") {
    if (!site.vaultCredential) {
      return NextResponse.json({ error: "no_upstream_url" });
    }
    const probe = await probeGatewaySite({
      connectorId: site.connectorId,
      targetHost: site.vaultCredential.targetHost,
      targetPort: site.vaultCredential.targetPort,
    });
    const transition = classifyTransition(site.probeOk, probe.probeOk);
    if (transition) {
      const detail = transition === "site_down" ? probe.probeDetail : null;
      await notifyTransition({ type: transition, siteId: id, siteName: site.name, detail });
    }
    await db.site.update({
      where: { id },
      data: { probedAt: new Date(), probeOk: probe.probeOk, probeDetail: probe.probeDetail, probeLatencyMs: probe.probeLatencyMs },
    });
    return NextResponse.json(probe.probeOk ? { ok: true, latencyMs: probe.probeLatencyMs } : { error: probe.probeDetail });
  }
  if (!site.upstreamUrl) {
    // A Site upgraded from an older version (or not yet configured) has no
    // internal address — nothing to test until one is set.
    return NextResponse.json({ error: "no_upstream_url" });
  }

  const result = await proxyThroughConnector({
    connectorId: site.connectorId,
    upstreamUrl: site.upstreamUrl,
    insecureSkipVerify: site.insecureSkipVerify,
  });

  // Refresh the persisted Health column with a fresh probe so the row pill
  // agrees with this manual test instead of lagging until the hourly cron.
  const probe = await probeSite({ connectorId: site.connectorId, upstreamUrl: site.upstreamUrl });
  // Mirror the cron's transition alerting: a manual test that flips the state
  // must fire the same site_down/site_recovered notification, otherwise it
  // silently pre-empts the stored probeOk and the cron never sees the event.
  const transition = classifyTransition(site.probeOk, probe.probeOk);
  if (transition) {
    // Only a down event carries a failure reason; a recovered event has no
    // meaningful detail (probeDetail is just "reachable" on success).
    const detail = transition === "site_down" ? probe.probeDetail : null;
    await notifyTransition({ type: transition, siteId: id, siteName: site.name, detail });
  }
  await db.site.update({
    where: { id },
    data: { probedAt: new Date(), probeOk: probe.probeOk, probeDetail: probe.probeDetail, probeLatencyMs: probe.probeLatencyMs },
  });

  return NextResponse.json(result);
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
