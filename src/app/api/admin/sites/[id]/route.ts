import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { resolvedRevealRequiresReason } from "@/lib/settings/platform";
import { moveKeptSecret, type MovedSecret } from "@/lib/vault/retarget";
import { AFTER_REVEAL_ROTATES_MS } from "@/lib/vault/rotation";
import { keptSecretStillOpens, rotationColumnsForNewSecret, sealLegacyCredentials, storedSecretColumns, storedSecretFor, VaultInputError } from "@/lib/vault/store";
import { resolveConnectorChoice } from "@/lib/connector/groups";
import { connectorsThatCannotServe, NO_ENGINES_TEXT } from "@/lib/connector/platform";
import { Prisma } from "@/generated/prisma/client";
import { validateSiteInput } from "@/lib/site/validate";
import { DB_ENGINES } from "@/lib/database/params";
import { capabilityAllowed } from "@/lib/tenant/envelope";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { crossTenantHostnameTaken } from "@/lib/site/hostname";
import { parseLogoUpload } from "@/lib/site/logo";
import { appearanceFrom } from "@/lib/site/validate";
import { ICON_NAMES } from "@/lib/site/icons";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { reshareGroupSecrets } from "@/lib/vault/reshare";
import { nativeBlocksRotation, rotationOn } from "@/lib/vault/rotation";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { sshCaProblem } from "@/lib/vault/ssh-ca";
import { elevationProblem } from "@/lib/vault/elevation";


type Admin = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/**
 * The saved password cannot follow a new address, user name or connector on its own:
 * it is sealed to the target it was entered for. The admin either types it again, or
 * asks to keep it (`keepPassword`) and the connector re-seals it for the new target.
 * Keeping it is held to the same rule as revealing it: a written reason unless the
 * Policy page turned that off, and a line in the audit log either way.
 */
async function keepSavedPassword(
  id: string,
  holder: { connectorId: string; connectorGroupId?: string | null },
  target: { host: string; port: number; username: string },
  body: Record<string, unknown>,
): Promise<(MovedSecret & { reason: string }) | NextResponse> {
  if (body.keepPassword !== true) return NextResponse.json({ error: "vault_secret_required" }, { status: 400 });
  const reason = typeof body.moveReason === "string" ? body.moveReason.trim() : "";
  if (reason.length < 10 && (await resolvedRevealRequiresReason())) return NextResponse.json({ error: "reason_required" }, { status: 400 });
  const m = await moveKeptSecret(id, holder, target);
  if ("error" in m) return NextResponse.json({ error: m.error, ...(m.detail ? { detail: m.detail } : {}) }, { status: m.status });
  return { ...m, reason };
}

/** After a kept password is saved at its new target: the audit line, and a rotation soon after when one is configured. */
async function afterPasswordMoved(id: string, name: string, m: MovedSecret & { reason: string }, admin: Admin, ip: string | null) {
  const rotatesAt = new Date(Date.now() + AFTER_REVEAL_ROTATES_MS);
  const rotating = await db.vaultCredential.updateMany({ where: { siteId: id, OR: [{ rotateAfterSession: true }, { rotateEveryDays: { not: null } }] }, data: { rotateDueAt: rotatesAt } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.password_retarget", targetType: "resource", targetId: id,
    summary: `Moved the saved password of ${m.from.username}@${m.from.host}:${m.from.port} to ${m.to.username}@${m.to.host}:${m.to.port} on "${name}"${m.reason ? `: ${m.reason}` : " (no reason given)"}`.slice(0, 500),
    metadata: { connectorId: m.connectorId, reason: m.reason.slice(0, 500), from: m.from, to: m.to, rotatesAt: rotating.count ? rotatesAt.toISOString() : null },
    clientIp: ip,
  });
}

export const PATCH = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // A connector, or a connector group standing in through one of its members.
  const choice = await resolveConnectorChoice(body);
  if ("error" in choice) return NextResponse.json({ error: choice.error }, { status: 400 });
  body.connectorId = choice.connectorId;
  const connectorGroupId = choice.connectorGroupId;
  const holder = { connectorId: choice.connectorId, connectorGroupId };
  const [capGateway, capRecording, capIsolated] = await Promise.all([capabilityAllowed("gateway"), capabilityAllowed("recording"), capabilityAllowed("isolated")]);
  const v = validateSiteInput(body, { nativeGateway: nativeGatewayEnabled() && capGateway, requireSecret: false, recordingEnabled: recordingEnabled() && capRecording, isolationEnabled: isolationEnabled() && capIsolated, hostSuffix: await siteHostSuffix() });
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.error === "native_gateway_disabled" || v.error === "isolation_disabled" ? 403 : 400 });

  const connector = await db.connector.findUnique({ where: { id: v.connectorId }, select: { id: true } });
  if (!connector) return NextResponse.json({ error: "connector_not_found" }, { status: 400 });
  const cannotServe = await connectorsThatCannotServe(v.mode, v.connectorId, connectorGroupId);
  if (cannotServe.length) return NextResponse.json({ error: "connector_platform", detail: `${cannotServe.join(", ")}: ${NO_ENGINES_TEXT}` }, { status: 409 });

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
      await db.site.update({ where: { id }, data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: v.hostname, customDomain: v.customDomain, domainVerifiedAt: v.customDomain && v.hostname === existing.hostname ? undefined : null, upstreamUrl: v.upstreamUrl, description: v.description, insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, nativeRdp: false, accessMode: "TRANSPARENT", ...logoData } });
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
      await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: v.upstreamUrl, description: v.description, insecureSkipVerify: v.insecureSkipVerify, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, clipboardMode: v.clipboardMode, watermark: v.watermark, fileTransferMode: v.fileTransferMode, ...(v.egressMode !== undefined ? { egressMode: v.egressMode } : {}), ...(v.egressHosts !== undefined ? { egressHosts: v.egressHosts } : {}), nativeRdp: false, accessMode: "ISOLATED", ...logoData } });
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

  if (v.mode === "TUNNEL") {
    // A TCP tunnel: the service's address only. A saved account from an earlier type goes.
    await db.$transaction(async (tx) => {
      await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, tunnelHost: v.targetHost, tunnelPort: v.targetPort, recordSessions: false, keystrokeLogging: false, nativeRdp: false, nativeSsh: false, requireModerator: false, accessMode: "TUNNEL", ...logoData } });
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

  if ((v.mode === "KUBERNETES" || v.mode === "DATABASE") && v.secret?.source === "sshca") return NextResponse.json({ error: "ssh_ca_ssh_only" }, { status: 400 });
  if (v.mode === "KUBERNETES") {
    // The token is sealed to the API server's address and the account's name: change
    // either and it must be entered again. A credential of another kind isn't kept.
    const prev = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { protocol: true } });
    const hadKube = prev?.protocol === "KUBERNETES";
    if (!hadKube && !v.secret) return NextResponse.json({ error: "kube_token_required" }, { status: 400 });
    const target = { host: v.targetHost, port: v.targetPort, username: v.username };
    let moved: Awaited<ReturnType<typeof keepSavedPassword>> | null = null;
    if (!v.secret && !(await keptSecretStillOpens(id, holder, target))) {
      const m = await keepSavedPassword(id, holder, target, body);
      if (m instanceof NextResponse) return m;
      moved = m;
    }
    let secretUpdate: ReturnType<typeof storedSecretColumns> | Record<string, never> = moved?.columns ?? {};
    if (v.secret) {
      try {
        secretUpdate = storedSecretColumns(await storedSecretFor(holder, v.secret, target));
      } catch (e) {
        if (e instanceof VaultInputError) return NextResponse.json({ error: e.message }, { status: 409 });
        throw e;
      }
      if (!secretUpdate.sealedTo) return NextResponse.json({ error: "vault_connector_key_required" }, { status: 409 });
    }
    await db.$transaction(async (tx) => {
      await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, nativeRdp: false, nativeSsh: false, requireModerator: false, accessMode: "KUBERNETES", ...logoData } });
      const fields = { protocol: "KUBERNETES" as const, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, kubeParams: v.kubeParams as Prisma.InputJsonValue, guacParams: Prisma.DbNull, dbParams: Prisma.DbNull };
      if (hadKube) await tx.vaultCredential.update({ where: { siteId: id }, data: { ...fields, ...secretUpdate } });
      else {
        await tx.vaultCredential.deleteMany({ where: { siteId: id } });
        await tx.vaultCredential.create({ data: { siteId: id, ...fields, ...(secretUpdate as ReturnType<typeof storedSecretColumns>), secretKind: "PASSWORD" } });
      }
    });
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "resource.update", targetType: "resource", targetId: id,
      summary: `Updated resource "${v.name}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
    if (moved) await afterPasswordMoved(id, v.name, moved, admin, clientIp(req.headers) ?? null);
    if (connectorGroupId && hadKube && !v.secret) await reshareGroupSecrets({ groupIds: [connectorGroupId] }, { id: admin.id, email: admin.email }).catch((e) => console.error("vault: copying secrets to the group failed", e));
    return NextResponse.json({ ok: true });
  }

  if (v.mode === "DATABASE") {
    const prev = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { protocol: true, targetHost: true, targetPort: true } });
    // A credential of another kind (a remote desktop's) is not kept for a database;
    // one for the other engine is, as its password is sealed to the address, not the engine.
    const hadDb = (DB_ENGINES as readonly string[]).includes(prev?.protocol ?? "");
    if (!hadDb && !v.secret) return NextResponse.json({ error: "remote_desktop_fields_required" }, { status: 400 });
    const target = { host: v.targetHost, port: v.targetPort, username: v.username };
    let moved: Awaited<ReturnType<typeof keepSavedPassword>> | null = null;
    if (!v.secret && !(await keptSecretStillOpens(id, holder, target))) {
      const m = await keepSavedPassword(id, holder, target, body);
      if (m instanceof NextResponse) return m;
      moved = m;
    }
    let secretUpdate: ReturnType<typeof storedSecretColumns> | Record<string, never> = moved?.columns ?? {};
    let rotationUpdate: ReturnType<typeof rotationColumnsForNewSecret> | Record<string, never> = {};
    if (v.secret) {
      try {
        secretUpdate = storedSecretColumns(await storedSecretFor(holder, v.secret, target));
      } catch (e) {
        if (e instanceof VaultInputError) return NextResponse.json({ error: e.message }, { status: 409 });
        throw e;
      }
      if (!secretUpdate.sealedTo) return NextResponse.json({ error: "vault_connector_key_required" }, { status: 409 });
      rotationUpdate = rotationColumnsForNewSecret(prev, target);
    }
    if (moved) rotationUpdate = rotationColumnsForNewSecret(prev, target);
    await db.$transaction(async (tx) => {
      await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: false, nativeRdp: false, nativeSsh: false, requireModerator: false, passwordCheckout: v.passwordCheckout, checkoutMaxMinutes: v.checkoutMaxMinutes, accessMode: "DATABASE", ...logoData } });
      const fields = { protocol: v.engine, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, dbParams: v.dbParams as Prisma.InputJsonValue, guacParams: Prisma.DbNull };
      if (hadDb) await tx.vaultCredential.update({ where: { siteId: id }, data: { ...fields, ...secretUpdate, ...rotationUpdate } });
      else {
        await tx.vaultCredential.deleteMany({ where: { siteId: id } });
        await tx.vaultCredential.create({ data: { siteId: id, ...fields, ...(secretUpdate as ReturnType<typeof storedSecretColumns>), secretKind: "PASSWORD" } });
      }
    });
    await recordAdminAction({
      actor: { id: admin.id, email: admin.email },
      action: "resource.update", targetType: "resource", targetId: id,
      summary: `Updated resource "${v.name}"`,
      clientIp: clientIp(req.headers) ?? null,
    });
    if (moved) await afterPasswordMoved(id, v.name, moved, admin, clientIp(req.headers) ?? null);
    if (connectorGroupId && hadDb && !v.secret) await reshareGroupSecrets({ groupIds: [connectorGroupId] }, { id: admin.id, email: admin.email }).catch((e) => console.error("vault: copying secrets to the group failed", e));
    return NextResponse.json({ ok: true });
  }

  // GATEWAY update: a first-time credential must include a secret.
  const hadVault = (await db.vaultCredential.count({ where: { siteId: id } })) > 0;
  // A certificate sign-in is the recorded native SSH path's: it is checked against what the resource will be after this save.
  const prevCred = hadVault ? await db.vaultCredential.findUnique({ where: { siteId: id }, select: { secretSource: true, elevate: true, rotationAccount: true } }) : null;
  // Administrator rights during sessions need the recorded native SSH path the resource is being saved with.
  if (prevCred?.elevate) {
    const bad = elevationProblem({ protocol: v.protocol, nativeSsh: v.nativeSsh, nativeRdp: v.nativeRdp, recorded: await effectiveSiteRecording(v.recordSessions), account: "kept", username: v.username });
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  }
  if ((v.secret ? v.secret.source : prevCred?.secretSource) === "sshca") {
    const bad = sshCaProblem({ protocol: v.protocol, nativeSsh: v.nativeSsh, recorded: await effectiveSiteRecording(v.recordSessions) });
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  }
  // A native client signs in with a password the user types; a rotated one nobody
  // knows. Recorded native SSH is the exception: Captivo signs in for the user.
  if (nativeBlocksRotation({ nativeRdp: v.nativeRdp, nativeSsh: v.nativeSsh, recorded: await effectiveSiteRecording(v.recordSessions) })) {
    const rot = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { rotateAfterSession: true, rotateEveryDays: true } });
    if (rot && rotationOn(rot)) return NextResponse.json({ error: "native_with_rotation" }, { status: 400 });
  }
  if (!hadVault && !v.secret) return NextResponse.json({ error: "remote_desktop_fields_required" }, { status: 400 });

  const target = { host: v.targetHost, port: v.targetPort, username: v.username };
  // A secret sealed to the connector opens only for the target and connector
  // it was entered for: changing either needs it again (see keptSecretStillOpens).
  let moved: Awaited<ReturnType<typeof keepSavedPassword>> | null = null;
  if (!v.secret && hadVault && !(await keptSecretStillOpens(id, holder, target))) {
    const m = await keepSavedPassword(id, holder, target, body);
    if (m instanceof NextResponse) return m;
    moved = m;
  }
  let secretUpdate: ReturnType<typeof storedSecretColumns> | Record<string, never> = moved?.columns ?? {}; // set whenever there was no credential (checked above)
  let rotationUpdate: ReturnType<typeof rotationColumnsForNewSecret> | Record<string, never> = {};
  if (moved) rotationUpdate = rotationColumnsForNewSecret(await db.vaultCredential.findUnique({ where: { siteId: id }, select: { targetHost: true, targetPort: true } }), target);
  if (v.secret) {
    try {
      secretUpdate = storedSecretColumns(await storedSecretFor(holder, v.secret, target));
      rotationUpdate = rotationColumnsForNewSecret(await db.vaultCredential.findUnique({ where: { siteId: id }, select: { targetHost: true, targetPort: true } }), target);
    } catch (e) {
      if (e instanceof VaultInputError) return NextResponse.json({ error: e.message }, { status: 409 });
      throw e;
    }
  }
  await db.$transaction(async (tx) => {
    await tx.site.update({ where: { id }, data: { connectorId: v.connectorId, connectorGroupId, name: v.name, hostname: null, upstreamUrl: null, description: v.description, recordSessions: v.recordSessions, keystrokeLogging: v.keystrokeLogging, watermark: v.watermark, clipboardMode: v.clipboardMode, nativeRdp: v.nativeRdp, nativeSsh: v.nativeSsh, requireModerator: v.requireModerator, passwordCheckout: v.passwordCheckout, checkoutMaxMinutes: v.checkoutMaxMinutes, accessMode: "GATEWAY", ...logoData } });
    // Not an upsert: Prisma validates the create branch even when the row
    // exists, and a kept secret leaves it without the required `secret`.
    const fields = { protocol: v.protocol, targetHost: v.targetHost, targetPort: v.targetPort, username: v.username, guacParams: v.guacParams as Prisma.InputJsonValue };
    if (hadVault) await tx.vaultCredential.update({ where: { siteId: id }, data: { ...fields, ...secretUpdate, ...rotationUpdate } });
    else await tx.vaultCredential.create({ data: { siteId: id, ...fields, ...(secretUpdate as ReturnType<typeof storedSecretColumns>), secretKind: "PASSWORD" } });
  });
  // A kept legacy secret is sealed for the (possibly new) target right away.
  await sealLegacyCredentials({ siteId: id });
  if (moved) await afterPasswordMoved(id, v.name, moved, admin, clientIp(req.headers) ?? null);
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "resource.update", targetType: "resource", targetId: id,
    summary: `Updated resource "${v.name}"`,
    clientIp: clientIp(req.headers) ?? null,
  });
  // A kept password moved onto a group: the members without a copy get one.
  if (connectorGroupId && hadVault && !v.secret) await reshareGroupSecrets({ groupIds: [connectorGroupId] }, { id: admin.id, email: admin.email }).catch((e) => console.error("vault: copying secrets to the group failed", e));
  return NextResponse.json({ ok: true });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });

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
