import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { callConnector, nativeBlocksRotation, windowsAccountOf } from "@/lib/vault/rotation";
import { kickRotation } from "@/lib/vault/rotation-pass";
import { storedSecretColumns, storedSecretFor, VaultInputError } from "@/lib/vault/store";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { compareSemver } from "@/lib/updates/semver";
import { assertWithinLimit, LimitError } from "@/lib/tenant/envelope";
import { ADOPT_MAX, acceptAccounts, adoptProblem, adoptedName, DISCOVER_MIN_CONNECTOR, DISCOVER_WINDOWS_MIN_CONNECTOR, DISCOVER_DB_MIN_CONNECTOR, type DiscoveredRow } from "@/lib/vault/discovery";
import { Prisma } from "@/generated/prisma/client";
import { parseDbParams, dbEngineOf } from "@/lib/database/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lists the accounts of the server an SSH resource points at (through its
// administrator account), and takes some over as resources of their own.

/** The password a new resource starts with: it does not sign in, and is replaced at once by the takeover. */
const placeholderPassword = () => randomBytes(24).toString("base64url");

type Platform = "linux" | "windows" | "postgres" | "mysql";

type Admin = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

async function scan(siteId: string): Promise<{ error: string; status: number; detail?: string } | { rows: DiscoveredRow[]; admin: string; platform: Platform; src: NonNullable<Awaited<ReturnType<typeof load>>> }> {
  const src = await load(siteId);
  if (!src || !src.vaultCredential) return { error: "not_found", status: 404 };
  const c = src.vaultCredential;
  const platform: Platform | null = c.protocol === "SSH" ? "linux" : c.protocol === "RDP" ? "windows" : c.protocol === "POSTGRES" ? "postgres" : c.protocol === "MYSQL" ? "mysql" : null;
  if (!platform) return { error: "discovery_ssh_only", status: 400, detail: "Accounts can be listed on a Linux server reached over SSH, a Windows server reached over remote desktop, or in PostgreSQL or MySQL." };
  if (platform === "windows" && windowsAccountOf({ username: c.username, guacParams: c.guacParams, rotationAccount: c.rotationAccount }).account === "domain") return { error: "discovery_local_only", status: 400, detail: "Only the local accounts of a Windows server can be listed; this resource's account is a domain account." };
  const min = platform === "windows" ? DISCOVER_WINDOWS_MIN_CONNECTOR : platform === "linux" ? DISCOVER_MIN_CONNECTOR : DISCOVER_DB_MIN_CONNECTOR;
  const dbp = platform === "postgres" || platform === "mysql" ? parseDbParams(c.dbParams, dbEngineOf(c.protocol)) : null;
  const seals = c.reconcileSeals && typeof c.reconcileSeals === "object" && !Array.isArray(c.reconcileSeals) ? (c.reconcileSeals as Record<string, string>) : {};
  if (!c.reconcileUsername || Object.keys(seals).length === 0) return { error: "discovery_needs_account", status: 409, detail: "Add the administrator account (root, or one that can use sudo) in Administrator rights during sessions first." };
  const holders = (src.connectorGroup ? src.connectorGroup.members.map((m) => m.connector) : [src.connector]).filter((h) => h.status === "ONLINE" && h.vaultPublicKey && seals[h.vaultPublicKey] && compareSemver(h.version, min) !== -1);
  const pick = holders[0];
  if (!pick) return { error: "discovery_waiting", status: 409, detail: `Needs an online connector on ${min} or later that holds the administrator account.` };
  const ans = await callConnector(pick.id, {
    op: "discover", method: platform, host: c.targetHost, port: String(c.targetPort), username: c.username,
    reconcile: { host: c.targetHost, port: String(c.targetPort), username: c.reconcileUsername, sealed: seals[pick.vaultPublicKey!], secretKey: c.reconcileKind === "KEY" },
    ...(platform === "linux" && c.sshHostKey ? { sshHostKey: c.sshHostKey } : {}),
    ...(dbp ? { db: { database: dbp.database, tls: dbp.tls, caCertPem: dbp.caCertPem } } : {}),
  } as Record<string, unknown>);
  if (ans.error || ans.outcome !== "ok") return { error: "discovery_failed", status: 502, detail: ans.error ?? ans.detail ?? "The connector could not list the accounts." };
  const accounts = acceptAccounts((ans as { accounts?: unknown }).accounts);
  const taken = await db.vaultCredential.findMany({ where: { targetHost: c.targetHost, targetPort: c.targetPort, protocol: c.protocol }, select: { username: true, site: { select: { id: true, name: true } } } });
  const by = new Map(taken.map((t) => [t.username, t.site]));
  return { rows: accounts.map((a) => ({ ...a, managedBy: by.get(a.name) ?? null })), admin: c.reconcileUsername, platform, src };
}

function load(siteId: string) {
  return db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true, name: true, connectorId: true, connectorGroupId: true, recordSessions: true, keystrokeLogging: true, watermark: true, clipboardMode: true, nativeSsh: true, nativeRdp: true, requireModerator: true,
      connector: { select: { id: true, status: true, version: true, vaultPublicKey: true } },
      connectorGroup: { select: { members: { orderBy: { createdAt: "asc" }, select: { connector: { select: { id: true, status: true, version: true, vaultPublicKey: true } } } } } },
      vaultCredential: { select: { protocol: true, targetHost: true, targetPort: true, username: true, guacParams: true, dbParams: true, rotationAccount: true, sshHostKey: true, reconcileUsername: true, reconcileKind: true, reconcileSeals: true } },
    },
  });
}

async function adminOf(): Promise<{ error: NextResponse } | { user: Admin }> {
  const u = await getCurrentUser();
  if (!u) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!can(u.role, "configure")) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user: u };
}

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const a = await adminOf();
  if ("error" in a) return a.error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const actor = { id: a.user.id, email: a.user.email };
  const ip = clientIp(req.headers) ?? null;

  const res = await scan(id);
  if ("error" in res) return NextResponse.json({ error: res.error, detail: res.detail }, { status: res.status });

  if (b.action === "scan") {
    await recordAdminAction({ actor, action: "resource.discovery_scan", targetType: "resource", targetId: id, summary: `Listed the accounts of ${res.src.vaultCredential!.targetHost} (${res.rows.length}) from "${res.src.name}"`, clientIp: ip });
    return NextResponse.json({ accounts: res.rows, administrator: res.admin, platform: res.platform });
  }

  if (b.action === "adopt") {
    const names = Array.isArray(b.accounts) ? [...new Set(b.accounts.filter((x): x is string => typeof x === "string"))] : [];
    if (names.length === 0 || names.length > ADOPT_MAX) return NextResponse.json({ error: "invalid_accounts", detail: `Pick between 1 and ${ADOPT_MAX} accounts.` }, { status: 400 });
    const src = res.src;
    const cred = src.vaultCredential!;
    try {
      await assertWithinLimit("maxSites", (await db.site.count()) + names.length - 1);
    } catch (e) {
      if (e instanceof LimitError) return NextResponse.json({ error: "limit_reached", limit: e.key, max: e.max }, { status: 409 });
      throw e;
    }
    const recorded = await effectiveSiteRecording(src.recordSessions);
    // A native client needs a password the user knows; rotation is what takes the account over, so it stays off unless sessions are recorded.
    const isDb = res.platform === "postgres" || res.platform === "mysql";
    const wasNative = isDb ? false : res.platform === "windows" ? src.nativeRdp : src.nativeSsh;
    const keepNative = wasNative && !nativeBlocksRotation({ nativeRdp: res.platform === "windows", nativeSsh: res.platform === "linux", recorded });
    const created: { id: string; name: string; username: string }[] = [];
    const refused: { name: string; reason: string }[] = [];
    for (const name of names) {
      const row = res.rows.find((r) => r.name === name);
      const why = !row ? "The server does not have this account any more." : adoptProblem(row, res.admin, res.platform);
      if (why) { refused.push({ name, reason: why }); continue; }
      const target = { host: cred.targetHost, port: cred.targetPort, username: name };
      let stored;
      try {
        stored = await storedSecretFor({ connectorId: src.connectorId, connectorGroupId: src.connectorGroupId }, { secret: placeholderPassword() }, target);
      } catch (e) {
        if (e instanceof VaultInputError) { refused.push({ name, reason: e.message }); continue; }
        throw e;
      }
      if (!stored.sealedTo) { refused.push({ name, reason: "The connector has no vault key yet: update it." }); continue; }
      const siteName = adoptedName(src.name, name);
      const site = await db.$transaction(async (tx) => {
        const s = await tx.site.create({
          data: {
            connectorId: src.connectorId, connectorGroupId: src.connectorGroupId, name: siteName, hostname: null, upstreamUrl: null,
            description: `Taken over from "${src.name}" by account discovery.`, recordSessions: src.recordSessions, keystrokeLogging: isDb ? false : src.keystrokeLogging,
            watermark: src.watermark, clipboardMode: src.clipboardMode, nativeSsh: res.platform === "linux" && keepNative, nativeRdp: res.platform === "windows" && keepNative, requireModerator: isDb ? false : src.requireModerator, accessMode: isDb ? "DATABASE" : "GATEWAY",
          },
          select: { id: true },
        });
        await tx.vaultCredential.create({
          data: {
            siteId: s.id, protocol: cred.protocol, targetHost: cred.targetHost, targetPort: cred.targetPort, username: name, ...storedSecretColumns(stored), secretKind: "PASSWORD",
            guacParams: isDb ? Prisma.DbNull : ((cred.guacParams ?? {}) as Prisma.InputJsonValue), ...(isDb ? { dbParams: { ...(cred.dbParams as object), sessionRole: "" } as Prisma.InputJsonValue } : {}), sshHostKey: cred.sshHostKey, rotationAccount: res.platform === "windows" ? cred.rotationAccount ?? "local" : null,
            reconcileUsername: cred.reconcileUsername, reconcileKind: cred.reconcileKind, reconcileSeals: (cred.reconcileSeals ?? {}) as Prisma.InputJsonValue,
            rotateDueAt: new Date(),
          },
        });
        return s;
      });
      await recordAdminAction({ actor, action: "resource.create", targetType: "resource", targetId: site.id, summary: `Created resource "${siteName}" by taking over ${name}@${cred.targetHost} (account discovery on "${src.name}")`, clientIp: ip });
      // The password it starts with does not sign in: rotation resets it through the administrator account and keeps the new one sealed.
      kickRotation(0, { siteId: site.id, force: true, actor });
      created.push({ id: site.id, name: siteName, username: name });
    }
    return NextResponse.json({ created, refused, nativeLeftOff: wasNative && !keepNative });
  }
  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
