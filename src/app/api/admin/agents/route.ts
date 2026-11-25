import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { recordAdminAction } from "@/lib/audit/admin";
import { clientIp } from "@/lib/request-ip";
import { withTenantRoute } from "@/lib/tenant/request";
import { assertWithinLimit, LimitError } from "@/lib/tenant/envelope";
import { agentIdentityEmail, newAgentToken, parseAgentTokenInput } from "@/lib/agent/tokens";
import { agentCanUse } from "@/lib/agent/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Admin = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

async function admin(): Promise<{ error: NextResponse } | { user: Admin }> {
  const u = await getCurrentUser();
  if (!u) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!can(u.role, "configure")) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user: u };
}

// Agent tokens: list them, make one. The token itself is in the answer to
// the POST and nowhere else; only its hash is kept.
export const GET = withTenantRoute(async () => {
  const a = await admin();
  if ("error" in a) return a.error;
  const rows = await db.apiToken.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, prefix: true, siteIds: true, maxMinutes: true, autoApprove: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true } });
  return NextResponse.json({ tokens: rows });
});

export const POST = withTenantRoute(async (req: NextRequest) => {
  const a = await admin();
  if ("error" in a) return a.error;
  const input = parseAgentTokenInput((await req.json().catch(() => ({}))) as Record<string, unknown>);
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });
  const sites = await db.site.findMany({ where: { id: { in: input.siteIds } }, select: { id: true, name: true, accessMode: true, vaultCredential: { select: { protocol: true } } } });
  if (sites.length !== input.siteIds.length) return NextResponse.json({ error: "site_not_found" }, { status: 400 });
  const bad = sites.find((s) => !agentCanUse(s));
  if (bad) return NextResponse.json({ error: "site_not_supported", detail: `${bad.name} is not an SSH resource or a TCP tunnel: agents can connect to those for now.` }, { status: 400 });
  try {
    await assertWithinLimit("maxUsers", await db.user.count());
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: "limit_reached", limit: e.key, max: e.max }, { status: 409 });
    throw e;
  }
  const t = newAgentToken();
  const expiresAt = new Date(Date.now() + input.days * 86_400_000);
  const row = await db.$transaction(async (tx) => {
    const idn = await tx.user.create({ data: { email: `pending-${t.prefix}@agents.invalid`, name: `Agent: ${input.name}`, role: "VENDOR", status: "ACTIVE" }, select: { id: true } });
    await tx.user.update({ where: { id: idn.id }, data: { email: agentIdentityEmail(idn.id) } });
    return tx.apiToken.create({
      data: { name: input.name, userId: idn.id, tokenHash: t.hash, prefix: t.prefix, siteIds: input.siteIds, maxMinutes: input.maxMinutes, autoApprove: input.autoApprove, expiresAt, createdById: a.user.id },
      select: { id: true },
    });
  });
  await recordAdminAction({
    actor: { id: a.user.id, email: a.user.email }, action: "agent.token_create", targetType: "agent", targetId: row.id,
    summary: `Made the agent token "${input.name}" for ${sites.map((s) => s.name).join(", ")}: up to ${input.maxMinutes} minutes at a time, ${input.autoApprove ? "approved without a person" : "approved by a person"}, valid ${input.days} days`,
    metadata: { siteIds: input.siteIds, maxMinutes: input.maxMinutes, autoApprove: input.autoApprove, days: input.days },
    clientIp: clientIp(req.headers) ?? null,
  });
  return NextResponse.json({ id: row.id, token: t.token, prefix: t.prefix, expiresAt: expiresAt.toISOString() }, { status: 201, headers: { "cache-control": "no-store" } });
});
