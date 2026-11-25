import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { isSealedValue } from "@/lib/vault/seal";
import { rotationStatus } from "@/lib/vault/rotation-status";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { elevationPlatform, elevationProblem } from "@/lib/vault/elevation";
import { windowsAccountOf } from "@/lib/vault/rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINUX_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}\$?$/;
/** A Windows administrator account: Administrator, .\\Administrator or DOMAIN\\name. */
const WINDOWS_USER = /^(?:(?:\.|[A-Za-z0-9][A-Za-z0-9.-]{0,63})\\)?[^\s"\\/[\]:;|=,+*?<>@]{1,20}$/;

// Administrator rights during a session: the switch, and the administrator
// account that adds and removes the sudo entry (sealed in the browser to each
// of the resource's connectors, like the reconcile account it shares).
export const GET = withTenantRoute(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const s = await rotationStatus((await params).id);
  return s ? NextResponse.json(s) : NextResponse.json({ error: "not_found" }, { status: 404 });
});

export const PUT = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(u.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const s = await rotationStatus(id);
  const site = await db.site.findUnique({ where: { id }, select: { name: true, nativeSsh: true, nativeRdp: true, recordSessions: true, vaultCredential: { select: { guacParams: true, rotationAccount: true } } } });
  if (!s || !site) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // undefined keeps the account, null removes it, an object replaces it.
  let account: Record<string, unknown> = {};
  let accountName = s.reconcile?.username ?? null;
  if (b.account === null) {
    account = { reconcileUsername: null, reconcileKind: null, reconcileSeals: Prisma.DbNull };
    accountName = null;
  } else if (b.account && typeof b.account === "object") {
    const r = b.account as Record<string, unknown>;
    const username = typeof r.username === "string" ? r.username.trim() : "";
    if (!(elevationPlatform(s.protocol) === "windows" ? WINDOWS_USER : LINUX_USER).test(username)) return NextResponse.json({ error: "invalid_reconcile_user" }, { status: 400 });
    const keys = new Set(s.keys.map((k) => k.key));
    const seals: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.seals ?? {}) as Record<string, unknown>)) {
      if (!keys.has(k)) continue; // not a connector of this resource
      if (!isSealedValue(v)) return NextResponse.json({ error: "invalid_sealed_secret" }, { status: 400 });
      seals[k] = v;
    }
    if (Object.keys(seals).length === 0) return NextResponse.json({ error: "vault_key_changed" }, { status: 409 });
    account = { reconcileUsername: username, reconcileKind: r.kind === "KEY" ? "KEY" : "PASSWORD", reconcileSeals: seals as Prisma.InputJsonValue };
    accountName = username;
  }
  const elevate = b.elevate === undefined ? s.elevate : b.elevate === true;
  if (elevate) {
    const bad = elevationProblem({ protocol: s.protocol, nativeSsh: site.nativeSsh, nativeRdp: site.nativeRdp, recorded: await effectiveSiteRecording(site.recordSessions), account: accountName, username: s.target.username, windowsLocal: windowsAccountOf({ username: s.target.username, guacParams: site.vaultCredential?.guacParams, rotationAccount: site.vaultCredential?.rotationAccount }).account === "local" });
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  }
  await db.vaultCredential.update({ where: { siteId: id }, data: { elevate, ...account } });
  await recordAdminAction({
    actor: { id: u.id, email: u.email },
    action: "resource.elevation_update", targetType: "resource", targetId: id,
    summary: `${elevate ? `Turned on administrator rights during sessions for "${site.name}"` : `Turned off administrator rights during sessions for "${site.name}"`}${b.account === null ? "; removed the administrator account" : b.account ? `; set the administrator account to ${accountName}` : ""}`,
    metadata: { elevate },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
