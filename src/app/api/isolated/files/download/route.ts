import { NextResponse } from "next/server";
import { requireUser } from "@/lib/current-user";
import { evaluateAccess } from "@/lib/access/evaluate";
import { dataplaneFilesUrl, dataplaneSecretHeader } from "@/lib/dataplane/client";
import { withTenantRoute } from "@/lib/tenant/request";
import { fetchStreamWithHeaderTimeout } from "@/lib/net/fetch-timeout";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

/** How long the data plane may take to START answering a download. */
const FILE_HEAD_TIMEOUT_MS = 20_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenantRoute(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const siteId = url.searchParams.get("site") ?? "";
  const name = url.searchParams.get("name") ?? "";
  if (!siteId || !name) return NextResponse.json({ error: "site_and_name_required" }, { status: 400 });
  const decision = await evaluateAccess(user.id, siteId, new Date());
  if (!decision.allow) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const qs = `op=download&userId=${encodeURIComponent(user.id)}&siteId=${encodeURIComponent(siteId)}&name=${encodeURIComponent(name)}`;
  // Head-only: the body is streamed straight to the browser, and a ceiling on the
  // transfer would truncate a large download -- which arrives as a corrupt file
  // rather than an error.
  const res = await fetchStreamWithHeaderTimeout(dataplaneFilesUrl(qs), {
    headerTimeoutMs: FILE_HEAD_TIMEOUT_MS,
    headers: dataplaneSecretHeader(),
    cache: "no-store",
  });
  if (!res.ok || !res.body) return NextResponse.json({ error: "unavailable" }, { status: res.status || 502 });
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": res.headers.get("content-disposition") ?? `attachment; filename="${name}"`,
    },
  });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
