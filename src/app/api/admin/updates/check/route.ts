import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { can } from "@/lib/auth/roles";
import { getUpdateCheckConfig, saveUpdateCheckResult } from "@/lib/updates/update-check-config";
import { parseLatestRelease } from "@/lib/updates/github";
import { withTenantRoute } from "@/lib/tenant/request";

const RELEASES_URL = "https://api.github.com/repos/captivo-io/captivo-access/releases/latest";

export const POST = withTenantRoute(async () => {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(admin.role, "configure")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const cfg = await getUpdateCheckConfig();
  if (!cfg || !cfg.enabled) return NextResponse.json({ ok: false, reason: "disabled" });

  // Best-effort: a public GET for the latest release. No request body, no auth,
  // no install data is sent. Any failure records lastCheckOk=false and returns
  // cleanly — it never throws and never blocks a page.
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "captivo-access" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await saveUpdateCheckResult({ latestVersion: null, latestUrl: null, ok: false });
      return NextResponse.json({ ok: false });
    }
    const { latestVersion, latestUrl } = parseLatestRelease(await res.json().catch(() => null));
    await saveUpdateCheckResult({ latestVersion, latestUrl, ok: true });
    return NextResponse.json({ ok: true, latestVersion });
  } catch {
    await saveUpdateCheckResult({ latestVersion: null, latestUrl: null, ok: false });
    return NextResponse.json({ ok: false });
  }
});
