import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { resolvedConnectorLogLevel, resolvedRecordingRetentionDays } from "@/lib/settings/platform";
import { pendingErasuresByConnector } from "@/lib/recording/erasure";
import { currentTenantId } from "@/lib/tenant/context";
import { requireDataplaneSecret, resolveTenantByConnector, withTenantFrom } from "@/lib/tenant/internal";
import { isVaultPublicKey } from "@/lib/vault/seal";
import { sealLegacyCredentials } from "@/lib/vault/store";
import { recordConnectorEvent } from "@/lib/connector/history";

function dataplaneAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantByConnector(typeof body.connectorId === "string" ? body.connectorId : "");
}

async function handler(req: NextRequest) {
  if (!dataplaneAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
  const status = body.status === "ONLINE" || body.status === "OFFLINE" ? body.status : null;
  if (!connectorId || !status) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  // Never resurrect a REVOKED connector: the data-plane's automatic ONLINE/OFFLINE
  // reports must not overwrite an admin revocation (otherwise an OFFLINE report on
  // session teardown would clear REVOKED and let the connector re-authenticate).
  // updateMany with a status guard also no-ops safely if the connector was deleted.
  const before = await db.connector.findUnique({ where: { id: connectorId }, select: { status: true, version: true } });
  await db.connector.updateMany({
    where: { id: connectorId, status: { not: "REVOKED" } },
    data: {
      status,
      lastSeenAt: new Date(),
      ...(typeof body.remoteAddr === "string" ? { remoteAddr: body.remoteAddr } : {}),
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      // The connector's vault key: a changed one means its /data was lost, and
      // secrets sealed to the old key need entering again (shown on the resource).
      ...(isVaultPublicKey(body.vaultPublicKey) ? { vaultPublicKey: body.vaultPublicKey } : {}),
    },
  });
  // The card's event history: the tunnel coming and going, and new versions.
  if (before && before.status !== "REVOKED") {
    if (status === "ONLINE" && before.status !== "ONLINE") {
      await recordConnectorEvent(connectorId, "ok", before.status === "PENDING" ? "Paired and connected" : "Tunnel opened");
    } else if (status === "OFFLINE" && before.status === "ONLINE") {
      await recordConnectorEvent(connectorId, "bad", "Tunnel dropped");
    }
    if (typeof body.version === "string" && before.version && body.version !== before.version) {
      await recordConnectorEvent(connectorId, "info", `Updated ${before.version} → ${body.version}`);
    }
  }
  // Seal what the cloud still holds in a form it can open, now that this
  // connector can open seals. Never blocks the connector coming online.
  if (status === "ONLINE" && isVaultPublicKey(body.vaultPublicKey)) {
    await sealLegacyCredentials({ connectorId }).catch((e) => console.error("vault: sealing legacy secrets failed", e));
  }
  const c = await db.connector.findUnique({ where: { id: connectorId }, select: { egressPolicy: true, logLevel: true } });
  // Carry the recording policy on connect too, so a reconnecting connector resumes
  // its retention sweep and learns any erasures it still owes — previously the
  // on-connect push omitted these, so deletions only ever reached a connector via
  // a later egress/log-level change.
  return NextResponse.json({
    ok: true,
    egressPolicy: c?.egressPolicy ?? "",
    logLevel: await resolvedConnectorLogLevel(c?.logLevel ?? null),
    tenantId: currentTenantId(),
    recordingRetentionDays: await resolvedRecordingRetentionDays(),
    purgeRecordingKeys: (await pendingErasuresByConnector()).get(connectorId) ?? [],
  });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
