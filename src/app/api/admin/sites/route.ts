import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { encrypt } from "@/lib/crypto";
import type { Prisma } from "@/generated/prisma/client";
import { validateSiteInput } from "@/lib/site/validate";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { crossTenantHostnameTaken } from "@/lib/site/hostname";
import { capabilityAllowed, assertWithinLimit, LimitError } from "@/lib/tenant/envelope";
import { parseLogoUpload } from "@/lib/site/logo";
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
  const logoData = logoResult.action === "set" ? { logo: logoResult.data, logoType: logoResult.type } : {};

  if (v.mode === "TRANSPARENT") {
    if (await crossTenantHostnameTaken(v.hostname)) {
      return NextResponse.json({ error: "hostname_taken" }, { status: 409 });
    }
    try {
      const site = await db.site.create({
        data: {
          connectorId: v.connectorId, name: v.name, hostname: v.hostname, customDomain: v.customDomain, upstreamUrl: v.upstreamUrl, description: v.description,
          insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, accessMode: "TRANSPARENT", ...logoData,
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
        connectorId: v.connectorId, name: v.name, hostname: null, upstreamUrl: v.upstreamUrl, description: v.description,
        insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, accessMode: "ISOLATED", ...logoData,
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

  // GATEWAY (remote desktop): the site (null hostname/upstream) + its credential, atomically.
  const encSecret = encrypt(v.secret as string);
  const id = await db.$transaction(async (tx) => {
    const site = await tx.site.create({
      data: { connectorId: v.connectorId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, accessMode: "GATEWAY", ...logoData },
      select: { id: true },
    });
    await tx.vaultCredential.create({
      data: { siteId: site.id, protocol: v.protocol, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, secret: encSecret, secretKind: "PASSWORD", guacParams: v.guacParams as Prisma.InputJsonValue },
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
