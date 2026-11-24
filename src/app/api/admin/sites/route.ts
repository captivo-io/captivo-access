import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { storedSecretColumns, storedSecretFor, VaultInputError } from "@/lib/vault/store";
import { resolveConnectorChoice } from "@/lib/connector/groups";
import type { Prisma } from "@/generated/prisma/client";
import { validateSiteInput } from "@/lib/site/validate";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { crossTenantHostnameTaken } from "@/lib/site/hostname";
import { capabilityAllowed, assertWithinLimit, LimitError } from "@/lib/tenant/envelope";
import { parseLogoUpload } from "@/lib/site/logo";
import { appearanceFrom } from "@/lib/site/validate";
import { ICON_NAMES } from "@/lib/site/icons";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const POST = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "configure")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // A connector, or a connector group standing in through one of its members.
  const choice = await resolveConnectorChoice(body);
  if ("error" in choice) return NextResponse.json({ error: choice.error }, { status: 400 });
  body.connectorId = choice.connectorId;
  const connectorGroupId = choice.connectorGroupId;
  // Capabilities: the deployment flag, overridable per tenant from the platform console.
  const [capGateway, capRecording, capIsolated] = await Promise.all([capabilityAllowed("gateway"), capabilityAllowed("recording"), capabilityAllowed("isolated")]);
  const v = validateSiteInput(body, { nativeGateway: nativeGatewayEnabled() && capGateway, requireSecret: true, recordingEnabled: recordingEnabled() && capRecording, isolationEnabled: isolationEnabled() && capIsolated, hostSuffix: await siteHostSuffix() });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.error === "native_gateway_disabled" || v.error === "isolation_disabled" ? 403 : 400 });
  try {
    await assertWithinLimit("maxSites", await db.site.count());
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: "limit_reached", limit: e.key, max: e.max }, { status: 409 });
    throw e;
  }

  const connector = await db.connector.findUnique({ where: { id: v.connectorId }, select: { id: true } });
  if (!connector) {
    return NextResponse.json({ error: "connector_not_found" }, { status: 400 });
  }

  const logoResult = parseLogoUpload(body.logo, body.logoType);
  if (logoResult.action === "error") {
    return NextResponse.json({ error: logoResult.error }, { status: 400 });
  }
  const look = appearanceFrom(body, ICON_NAMES);
  if ("error" in look) return NextResponse.json({ error: look.error }, { status: 400 });
  const logoData = { ...(logoResult.action === "set" ? { logo: logoResult.data, logoType: logoResult.type } : {}), ...look };

  if (v.mode === "TRANSPARENT") {
    if (await crossTenantHostnameTaken(v.hostname)) {
      return NextResponse.json({ error: "hostname_taken" }, { status: 409 });
    }
    try {
      const site = await db.site.create({
        data: {
          connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: v.hostname, customDomain: v.customDomain, upstreamUrl: v.upstreamUrl, description: v.description,
          insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, accessMode: "TRANSPARENT", ...logoData,
        },
        select: { id: true },
      });
      await recordAdminAction({
        actor: { id: admin.id, email: admin.email },
        action: "resource.create",
        targetType: "resource", targetId: site.id,
        summary: `Created resource "${v.name}"`,
        clientIp: clientIp(req.headers) ?? null,
      });
      return NextResponse.json({ id: site.id });
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
        return NextResponse.json({ error: "hostname_taken" }, { status: 409 });
      }
      throw e;
    }
  }

  if (v.mode === "ISOLATED") {
    // Isolated browser: a site with the internal URL to open; no VaultCredential.
    const site = await db.site.create({
      data: {
        connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: v.upstreamUrl, description: v.description,
        insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, egressMode: v.egressMode ?? null, egressHosts: v.egressHosts ?? [], accessMode: "ISOLATED", ...logoData,
      },
      select: { id: true },
    });
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "resource.create",
      targetType: "resource", targetId: site.id,
      summary: `Created resource "${v.name}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
    return NextResponse.json({ id: site.id });
  }

  if (v.mode === "TUNNEL") {
    // A TCP tunnel: the service's address on the site; no credential, nothing recorded.
    const site = await db.site.create({
      data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, tunnelHost: v.targetHost, tunnelPort: v.targetPort, recordSessions: false, keystrokeLogging: false, accessMode: "TUNNEL", ...logoData },
      select: { id: true },
    });
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "resource.create",
      targetType: "resource", targetId: site.id,
      summary: `Created resource "${v.name}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
    return NextResponse.json({ id: site.id });
  }

  // GATEWAY (remote desktop) or DATABASE: the site (null hostname/upstream) + its credential, atomically.
  let stored;
  try {
    stored = await storedSecretFor({ connectorId: v.connectorId, connectorGroupId }, v.secret!, { host: v.targetHost, port: v.targetPort, username: v.username });
  } catch (e) {
    if (e instanceof VaultInputError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  // A database password opens only on a connector: the proxy never holds one.
  if (v.mode === "DATABASE" && !storedSecretColumns(stored).sealedTo) return NextResponse.json({ error: "vault_connector_key_required" }, { status: 409 });
  const id = await db.$transaction(async (tx) => {
    const site = await tx.site.create({
      data: v.mode === "DATABASE"
        ? { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: false, accessMode: "DATABASE", ...logoData }
        : { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, watermark: v.watermark, clipboardMode: v.clipboardMode, nativeRdp: v.nativeRdp, nativeSsh: v.nativeSsh, accessMode: "GATEWAY", ...logoData },
      select: { id: true },
    });
    await tx.vaultCredential.create({
      data: v.mode === "DATABASE"
        ? { siteId: site.id, protocol: v.engine, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, ...storedSecretColumns(stored), secretKind: "PASSWORD", dbParams: v.dbParams as Prisma.InputJsonValue }
        : { siteId: site.id, protocol: v.protocol, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, ...storedSecretColumns(stored), secretKind: "PASSWORD", guacParams: v.guacParams as Prisma.InputJsonValue },
    });
    return site.id;
  });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.create",
    targetType: "resource", targetId: id,
    summary: `Created resource "${v.name}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ id });
});

export const GET = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!can(admin.role, "read_console")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sites = await db.site.findMany({
    select: {
      id: true,
      name: true,
      hostname: true,
      upstreamUrl: true,
      description: true,
      connectorId: true,
      connector: { select: { name: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ sites });
});
