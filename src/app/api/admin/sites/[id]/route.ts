import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { keptSecretStillOpens, sealLegacyCredentials, storedSecretFor, VaultInputError, type StoredSecret } from "@/lib/vault/store";
import type { Prisma } from "@/generated/prisma/client";
import { validateSiteInput } from "@/lib/site/validate";
import { capabilityAllowed } from "@/lib/tenant/envelope";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { crossTenantHostnameTaken } from "@/lib/site/hostname";
import { parseLogoUpload } from "@/lib/site/logo";
import { appearanceFrom } from "@/lib/site/validate";
import { ICON_NAMES } from "@/lib/site/icons";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";

export const PATCH = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const [capGateway, capRecording, capIsolated] = await Promise.all([capabilityAllowed("gateway"), capabilityAllowed("recording"), capabilityAllowed("isolated")]);
  const v = validateSiteInput(body, { nativeGateway: nativeGatewayEnabled() && capGateway, requireSecret: false, recordingEnabled: recordingEnabled() && capRecording, isolationEnabled: isolationEnabled() && capIsolated, hostSuffix: await siteHostSuffix() });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.error === "native_gateway_disabled" || v.error === "isolation_disabled" ? 403 : 400 });

  const connector = await db.connector.findUnique({ where: { id: v.connectorId }, select: { id: true } });
  if (!connector) return NextResponse.json({ error: "connector_not_found" }, { status: 400 });

  const existing = await db.site.findUnique({ where: { id }, select: { id: true, hostname: true } });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const logoResult = parseLogoUpload(body.logo, body.logoType);
  if (logoResult.action === "error") return NextResponse.json({ error: logoResult.error }, { status: 400 });
  const baseLogo =
    logoResult.action === "set" ? { logo: logoResult.data, logoType: logoResult.type }
    : logoResult.action === "clear" ? { logo: null, logoType: null }
    : {};
  const look = appearanceFrom(body, ICON_NAMES);
  if ("error" in look) return NextResponse.json({ error: look.error }, { status: 400 });
  const logoData = { ...baseLogo, ...look };

  if (v.mode === "TRANSPARENT") {
    if (await crossTenantHostnameTaken(v.hostname)) {
      return NextResponse.json({ error: "hostname_taken" }, { status: 409 });
    }
    try {
      await db.site.update({ where: { id }, data: { connectorId: v.connectorId, name: v.name, hostname: v.hostname, customDomain: v.customDomain, domainVerifiedAt: v.customDomain && v.hostname === existing.hostname ? undefined : null, upstreamUrl: v.upstreamUrl, description: v.description, insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, nativeRdp: false, accessMode: "TRANSPARENT", ...logoData } });
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
        return NextResponse.json({ error: "hostname_taken" }, { status: 409 });
      }
      throw e;
    }
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "resource.update", targetType: "resource", targetId: id,
      summary: `Updated resource "${v.name}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  if (v.mode === "ISOLATED") {
    // Isolated browser: URL-only site, no credential. Drop any stale vault from a GATEWAY→ISOLATED switch.
    await db.$transaction(async (tx) => {
      await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, name: v.name, hostname: null, upstreamUrl: v.upstreamUrl, description: v.description, insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, ...(v.egressMode !== undefined ? { egressMode: v.egressMode } : {}), ...(v.egressHosts !== undefined ? { egressHosts: v.egressHosts } : {}), nativeRdp: false, accessMode: "ISOLATED", ...logoData } });
      await tx.vaultCredential.deleteMany({ where: { siteId: id } });
    });
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "resource.update", targetType: "resource", targetId: id,
      summary: `Updated resource "${v.name}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  // GATEWAY update: a first-time credential must include a secret.
  const hadVault = (await db.vaultCredential.count({ where: { siteId: id } })) > 0;
  if (!hadVault && !v.secret) return NextResponse.json({ error: "remote_desktop_fields_required" }, { status: 400 });

  const target = { host: v.targetHost, port: v.targetPort, username: v.username };
  // A secret sealed to the connector opens only for the target and connector
  // it was entered for: changing either needs it again (see keptSecretStillOpens).
  if (!v.secret && hadVault && !(await keptSecretStillOpens(id, v.connectorId, target))) {
    return NextResponse.json({ error: "vault_secret_required" }, { status: 400 });
  }
  let secretUpdate: StoredSecret | Record<string, never> = {}; // set whenever there was no credential (checked above)
  if (v.secret) {
    try {
      secretUpdate = await storedSecretFor(v.connectorId, v.secret, target);
    } catch (e) {
      if (e instanceof VaultInputError) return NextResponse.json({ error: e.message }, { status: 409 });
      throw e;
    }
  }
  await db.$transaction(async (tx) => {
    await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, watermark: v.watermark, clipboardMode: v.clipboardMode, nativeRdp: v.nativeRdp, nativeSsh: v.nativeSsh, accessMode: "GATEWAY", ...logoData } });
    // Not an upsert: Prisma validates the create branch even when the row
    // exists, and a kept secret leaves it without the required `secret`.
    const fields = { protocol: v.protocol, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, guacParams: v.guacParams as Prisma.InputJsonValue };
    if (hadVault) await tx.vaultCredential.update({ where: { siteId: id }, data: { ...fields, ...secretUpdate } });
    else await tx.vaultCredential.create({ data: { siteId: id, ...fields, ...(secretUpdate as StoredSecret), secretKind: "PASSWORD" } });
  });
  // A kept legacy secret is sealed for the (possibly new) target right away.
  await sealLegacyCredentials({ siteId: id });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.update", targetType: "resource", targetId: id,
    summary: `Updated resource "${v.name}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const existing = await db.site.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await db.site.delete({ where: { id } }); // cascades the Site's AccessGrant rows
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.delete", targetType: "resource", targetId: id,
    summary: `Deleted resource ${id}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
