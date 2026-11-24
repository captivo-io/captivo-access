import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";
import { isSealedValue, isVaultPublicKey } from "@/lib/vault/seal";
import { callConnector, canRotate, directoryForRotation, nextScheduled, isDbMethod, rotationMethod } from "@/lib/vault/rotation";
import { kickRotation } from "@/lib/vault/rotation-pass";
import { rotationStatus } from "@/lib/vault/rotation-status";
import { sealsOf } from "@/lib/vault/store";
import { compareSemver } from "@/lib/updates/semver";
import { VAULT_PROVIDER_MIN_CONNECTOR } from "@/lib/vault/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** After a reveal the password rotates again this much later (time to use it). */
const REVEAL_ROTATES_AFTER_MS = 2 * 60 * 60_000;
const LINUX_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}\$?$/;
/** A Windows reconcile account: Administrator, .\Administrator or DOMAIN\name (NetBIOS or DNS domain). */
const WINDOWS_USER = /^(?:(?:\.|[A-Za-z0-9][A-Za-z0-9.-]{0,63})\\)?[^\s"\\/[\]:;|=,+*?<>@]{1,20}$/;
/** A database account's name: it only signs in, it is never put in a statement. */
const DB_USER = /^[^\s'"\\]{1,63}$/;

type Admin = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

async function admin(): Promise<{ error: NextResponse } | { user: Admin }> {
  const u = await getCurrentUser();
  if (!u) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!can(u.role, "configure")) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user: u };
}

export const GET = withTenantRoute(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const a = await admin();
  if ("error" in a) return a.error;
  const s = await rotationStatus((await params).id);
  if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(s);
});

// The rotation settings: triggers, the reconcile account (Linux, Windows, a
// database), and for RDP whether the account is the server's own or the domain's.
export const PUT = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const a = await admin();
  if ("error" in a) return a.error;
  const { id } = await params;
  const s = await rotationStatus(id);
  if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const afterSession = b.afterSession === true;
  const everyDays = b.everyDays == null ? null : Number(b.everyDays);
  if (everyDays !== null && (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 365)) return NextResponse.json({ error: "invalid_interval" }, { status: 400 });
  const verifyDaily = b.verifyDaily === true;
  const on = afterSession || everyDays !== null;
  if ((on || verifyDaily) && s.unsupported && b.account === undefined) return NextResponse.json({ error: "rotation_unsupported", detail: s.unsupported }, { status: 400 });
  if (on && s.native) return NextResponse.json({ error: "rotation_with_native" }, { status: 400 });

  // RDP: undefined keeps, null goes back to reading it from the user name.
  let account: Record<string, unknown> = {};
  if (b.account !== undefined) {
    if (!s.windowsAccount) return NextResponse.json({ error: "account_rdp_only" }, { status: 400 });
    if (b.account !== null && b.account !== "local" && b.account !== "domain") return NextResponse.json({ error: "invalid_account" }, { status: 400 });
    account = { rotationAccount: b.account };
    const c = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { protocol: true, secretKind: true, username: true, guacParams: true } });
    const m = c ? rotationMethod({ ...c, rotationAccount: b.account as string | null }, await directoryForRotation()) : null;
    if (m && "unsupported" in m) {
      if (on || verifyDaily) return NextResponse.json({ error: "rotation_unsupported", detail: m.unsupported }, { status: 400 });
    } else if (m) s.method = m.method;
  }

  // undefined: keep; null: remove; object: replace (sealed in the browser).
  let reconcile: Record<string, unknown> = {};
  if (b.reconcile === null) reconcile = { reconcileUsername: null, reconcileKind: null, reconcileSeals: Prisma.DbNull };
  else if (b.reconcile && typeof b.reconcile === "object") {
    const db = isDbMethod(s.method);
    const win = s.method === "windows";
    if (s.method !== "linux" && !win && !db) return NextResponse.json({ error: "reconcile_linux_only" }, { status: 400 });
    const r = b.reconcile as Record<string, unknown>;
    const username = typeof r.username === "string" ? r.username.trim() : "";
    const kind = r.kind === "KEY" && s.method === "linux" ? "KEY" : "PASSWORD";
    if (!(db ? DB_USER : win ? WINDOWS_USER : LINUX_USER).test(username)) return NextResponse.json({ error: "invalid_reconcile_user" }, { status: 400 });
    const keys = new Set(s.keys.map((k) => k.key));
    const seals: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.seals ?? {}) as Record<string, unknown>)) {
      if (!keys.has(k)) continue; // not a connector of this resource
      if (!isSealedValue(v)) return NextResponse.json({ error: "invalid_sealed_secret" }, { status: 400 });
      seals[k] = v;
    }
    if (Object.keys(seals).length === 0) return NextResponse.json({ error: "vault_key_changed" }, { status: 409 });
    reconcile = { reconcileUsername: username, reconcileKind: kind, reconcileSeals: seals as Prisma.InputJsonValue };
  }

  const cur = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { rotatedAt: true, rotateDueAt: true, rotateEveryDays: true, rotateAfterSession: true } });
  const now = new Date();
  // The schedule sets the next date; switching everything off clears it.
  const dueAt = !on ? null : everyDays !== cur?.rotateEveryDays || !cur?.rotateDueAt ? nextScheduled({ rotateEveryDays: everyDays, rotatedAt: cur?.rotatedAt ?? null }, now) : cur.rotateDueAt;
  await db.vaultCredential.update({
    where: { siteId: id },
    data: { rotateAfterSession: afterSession, rotateEveryDays: everyDays, rotateVerifyDaily: verifyDaily, rotateDueAt: dueAt, ...reconcile, ...account },
  });
  const parts = [afterSession && "after each session", everyDays && `every ${everyDays} day${everyDays === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  const site = await db.site.findUnique({ where: { id }, select: { name: true } });
  await recordAdminAction({
    actor: { id: a.user.id, email: a.user.email },
    action: "resource.rotation_update", targetType: "resource", targetId: id,
    summary: `${on ? `Set "${site?.name}" to rotate its password ${parts}` : `Turned password rotation off for "${site?.name}"`}${verifyDaily ? ", checked daily" : ""}${b.reconcile === null ? "; removed the reconcile account" : b.reconcile ? `; reconcile account ${String((b.reconcile as Record<string, unknown>).username)}` : ""}`,
    metadata: { afterSession, everyDays, verifyDaily, ...(b.account !== undefined ? { account: b.account } : {}) },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

// "Rotate now", and "Reveal" (an admin sees the password once, with a reason).
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const a = await admin();
  if ("error" in a) return a.error;
  const { id } = await params;
  const s = await rotationStatus(id);
  if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const actor = { id: a.user.id, email: a.user.email };

  if (b.action === "rotate") {
    if (s.unsupported) return NextResponse.json({ error: "rotation_unsupported", detail: s.unsupported }, { status: 400 });
    if (s.native) return NextResponse.json({ error: "rotation_with_native" }, { status: 400 });
    if (s.waiting) return NextResponse.json({ error: "rotation_waiting", detail: s.waiting }, { status: 409 });
    await db.vaultCredential.update({ where: { siteId: id }, data: { rotateDueAt: new Date() } });
    kickRotation(0, { siteId: id, force: true, actor });
    return NextResponse.json({ ok: true });
  }

  // The customer's own vault: ask the connector to fetch it once and say whether the vault answers.
  if (b.action === "check") {
    if (!s.vaultSource) return NextResponse.json({ error: "not_external" }, { status: 400 });
    if (s.waiting) return NextResponse.json({ error: "rotation_waiting", detail: s.waiting }, { status: 409 });
    const c = await db.vaultCredential.findUnique({ where: { siteId: id }, select: { secret: true, sealedTo: true, extraSeals: true } });
    const seals = c ? sealsOf(c) : {};
    const holders = await db.connector.findMany({ where: { id: { in: s.keys.map((k) => k.connectorId) } }, select: { id: true, name: true, status: true, version: true, vaultPublicKey: true }, orderBy: { id: "asc" } });
    const pick = holders.find((h) => h.status === "ONLINE" && h.vaultPublicKey && seals[h.vaultPublicKey] && compareSemver(h.version, VAULT_PROVIDER_MIN_CONNECTOR) !== -1);
    if (!c || !pick) return NextResponse.json({ error: "rotation_waiting", detail: `Needs a connector on ${VAULT_PROVIDER_MIN_CONNECTOR} or later that holds the reference and is online.` }, { status: 409 });
    const ans = await callConnector(pick.id, { op: "verify", method: "ref", host: s.target.host, port: String(s.target.port), username: s.target.username, current: seals[pick.vaultPublicKey!] });
    const ok = ans.outcome === "ok" && !ans.error;
    await recordAdminAction({
      actor, action: "resource.vault_check", targetType: "resource", targetId: id,
      summary: `Checked the ${s.vaultSource === "cyberark" ? "CyberArk" : "HashiCorp Vault"} credential of ${s.target.username}@${s.target.host}: ${ok ? "the vault hands it out" : "failed"}`,
      metadata: { connectorId: pick.id, ok },
      clientIp: clientIp(req.headers) ?? null,
    });
    return NextResponse.json({ ok, detail: ok ? null : ans.detail ?? ans.error ?? "The vault did not answer." });
  }

  if (b.action === "reveal") {
    if (s.vaultSource) return NextResponse.json({ error: "reveal_external", detail: "This credential lives in your own vault; read it there." }, { status: 400 });
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 10) return NextResponse.json({ error: "reason_required" }, { status: 400 });
    if (!isVaultPublicKey(b.publicKey)) return NextResponse.json({ error: "invalid_key" }, { status: 400 });
    if (s.waiting) return NextResponse.json({ error: "rotation_waiting", detail: s.waiting }, { status: 409 });
    const c = await db.vaultCredential.findUnique({
      where: { siteId: id },
      select: { secret: true, sealedTo: true, extraSeals: true, site: { select: { name: true } } },
    });
    const seals = c ? sealsOf(c) : {};
    const holders = await db.connector.findMany({ where: { id: { in: s.keys.map((k) => k.connectorId) } }, select: { id: true, name: true, status: true, version: true, vaultPublicKey: true }, orderBy: { id: "asc" } });
    const pick = holders.find((h) => canRotate(h, s.method) && h.vaultPublicKey && seals[h.vaultPublicKey]);
    if (!c || !pick) return NextResponse.json({ error: "rotation_waiting", detail: s.waiting ?? "No connector can open it now." }, { status: 409 });
    const ans = await callConnector(pick.id, {
      op: "reveal", method: s.method ?? "linux", host: s.target.host, port: String(s.target.port), username: s.target.username,
      current: seals[pick.vaultPublicKey!], to: [b.publicKey],
    });
    const sealed = ans.seals?.[b.publicKey as string];
    if (ans.error || !isSealedValue(sealed)) return NextResponse.json({ error: "reveal_failed", detail: ans.error ?? "The connector's answer was unreadable." }, { status: 502 });
    const again = s.method ? new Date(Date.now() + REVEAL_ROTATES_AFTER_MS) : null;
    if (again && s.on) await db.vaultCredential.update({ where: { siteId: id }, data: { rotateDueAt: again } });
    await recordAdminAction({
      actor, action: "resource.password_reveal", targetType: "resource", targetId: id,
      summary: `Revealed the saved password of ${s.target.username}@${s.target.host} on "${c.site.name}": ${reason}`.slice(0, 500),
      metadata: { connectorId: pick.id, reason: reason.slice(0, 500), rotatesAt: again && s.on ? again.toISOString() : null },
      clientIp: clientIp(req.headers) ?? null,
    });
    return NextResponse.json({ sealed, target: s.target, rotatesAt: again && s.on ? again.toISOString() : null });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
