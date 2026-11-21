import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { isSealedValue } from "@/lib/vault/seal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The directory account password rotation uses to RESET an account's password
// (it holds the "Reset password" right): when the account cannot change its
// own (minimum password age, history) or its saved password no longer matches.
// Sealed in the browser to every connector, for "reconcile,<dc host>,<port>,<user>":
// the cloud cannot open it, and a connector uses it only against this directory.

export const PUT = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const username = typeof b.username === "string" ? b.username.trim() : "";
  if (!username || username.length > 256 || /[\r\n]/.test(username)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  const dir = await db.directoryConfig.findUnique({ where: { tenantId: currentTenantId() }, select: { host: true, port: true } });
  if (!dir?.host || dir.host !== String(b.host ?? "") || dir.port !== Number(b.port)) return NextResponse.json({ error: "directory_changed" }, { status: 409 });
  const keys = new Set((await db.connector.findMany({ where: { status: { not: "REVOKED" }, vaultPublicKey: { not: null } }, select: { vaultPublicKey: true } })).map((c) => c.vaultPublicKey!));
  const seals: Record<string, string> = {};
  for (const [k, v] of Object.entries((b.seals ?? {}) as Record<string, unknown>)) {
    if (!keys.has(k)) continue;
    if (!isSealedValue(v)) return NextResponse.json({ error: "invalid_sealed_secret" }, { status: 400 });
    seals[k] = v;
  }
  if (Object.keys(seals).length === 0) return NextResponse.json({ error: "vault_key_changed" }, { status: 409 });
  await db.directoryConfig.update({ where: { tenantId: currentTenantId() }, data: { resetUsername: username, resetSeals: seals as Prisma.InputJsonValue } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.directory_reset_account", targetType: "directory",
    summary: `Set the password reset account for rotation to ${username}`,
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await db.directoryConfig.updateMany({ data: { resetUsername: "", resetSeals: Prisma.DbNull } });
  await recordAdminAction({
    actor: { id: admin.id, email: admin.email },
    action: "config.directory_reset_account", targetType: "directory",
    summary: "Removed the password reset account for rotation",
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ ok: true });
});
