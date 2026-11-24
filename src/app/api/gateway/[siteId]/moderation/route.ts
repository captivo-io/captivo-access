import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { moderationRequired, type ModerationKind } from "@/lib/moderation/rules";
import { cancelRequest, moderatorCount, openRequest, requestFor } from "@/lib/moderation/requests";
import { withTenantRoute } from "@/lib/tenant/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The user's side of a moderated session: ask for a moderator (POST), see
// whether one admitted it (GET ?id=), give up waiting (DELETE ?id=).

export const POST = withTenantRoute(async (req: Request, { params }: { params: Promise<{ siteId: string }> }) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { siteId } = await params;
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown };
  const kind: ModerationKind = body.kind === "ssh" ? "ssh" : "browser";
  const site = await db.site.findUnique({ where: { id: siteId }, select: { name: true, accessMode: true, requireModerator: true } });
  if (!site || !moderationRequired(site)) return NextResponse.json({ error: "not_moderated" }, { status: 404 });
  const decision = await evaluateAccess(user.id, siteId, new Date());
  if (!decision.allow) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if ((await moderatorCount(user.id)) === 0) return NextResponse.json({ error: "no_moderators" }, { status: 409 });
  return NextResponse.json(await openRequest(siteId, user, kind, site.name), { headers: { "cache-control": "no-store" } });
});

export const GET = withTenantRoute(async (req: Request) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const r = id ? await requestFor(id, user.id) : null;
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
});

export const DELETE = withTenantRoute(async (req: Request) => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (id) await cancelRequest(id, user.id);
  return NextResponse.json({ ok: true });
});
