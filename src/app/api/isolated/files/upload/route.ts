import { NextResponse } from "next/server";
import { requireUser } from "@/lib/current-user";
import { evaluateAccess } from "@/lib/access/evaluate";
import { dataplaneFilesUrl, dataplaneSecretHeader } from "@/lib/dataplane/client";
import { withTenantRoute } from "@/lib/tenant/request";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { SLOW_SCOPE_BUDGET_MS } from "@/lib/tenant/scope";

/** An isolated-browser file transfer through the data plane. */
const FILE_TRANSFER_TIMEOUT_MS = 300_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = Number(process.env.ISOLATED_FT_MAX_BYTES ?? 100 * 1024 * 1024);

export const POST = withTenantRoute(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const siteId = url.searchParams.get("site") ?? "";
  const name = url.searchParams.get("name") ?? "";
  if (!siteId || !name) return NextResponse.json({ error: "site_and_name_required" }, { status: 400 });
  const decision = await evaluateAccess(user.id, siteId, new Date());
  if (!decision.allow) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (!len || Number.isNaN(len)) return NextResponse.json({ error: "length_required" }, { status: 411 });
  if (len > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const body = await req.arrayBuffer(); // bounded by the MAX_BYTES check above
  const qs = `op=upload&userId=${encodeURIComponent(user.id)}&siteId=${encodeURIComponent(siteId)}&name=${encodeURIComponent(name)}`;
  // The whole request is bounded, upload included: here the body IS the slow
  // part, so a head-only ceiling would bound nothing. Generous rather than tight
  // -- a real transfer must be able to finish.
  const res = await fetchWithTimeout(dataplaneFilesUrl(qs), {
    timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    method: "POST",
    headers: { ...dataplaneSecretHeader(), "content-type": "application/octet-stream", "content-length": String(body.byteLength) },
    body,
  });
  return NextResponse.json(res.ok ? { ok: true } : { ok: false }, { status: res.status });
}, { budgetMs: SLOW_SCOPE_BUDGET_MS });
