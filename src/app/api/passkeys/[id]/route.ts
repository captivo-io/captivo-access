import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { passkeyLabel } from "@/lib/auth/passkey-kind";

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const passkey = await db.passkey.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!passkey || passkey.userId !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Last-passkey guard: prevent the user from locking themselves out of the account.
  const count = await db.passkey.count({ where: { userId: user.id } });
  if (count <= 1) {
    return NextResponse.json({ error: "last_passkey" }, { status: 400 });
  }

  await db.passkey.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});

// Rename one of the person's own passkeys.
export const PATCH = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = passkeyLabel(body.label);
  if (!label) {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }
  const { id } = await params;
  const res = await db.passkey.updateMany({ where: { id, userId: user.id }, data: { label } });
  if (res.count === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, label });
});
