import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { db } from "@/lib/db";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { resolvedRecordingConsentRequired, resolvedClipboardDefault, resolvedWatermarkDefault } from "@/lib/settings/platform";
import { requireDataplaneSecret, resolveTenantByHostname, withTenantFrom } from "@/lib/tenant/internal";

function dataplaneAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host : "";
  return host ? resolveTenantByHostname(host) : null;
}

async function handler(req: NextRequest) {
  if (!dataplaneAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host : "";
  const hostname = host.toLowerCase().trim();
  if (!hostname) return NextResponse.json({ error: "no_site" }, { status: 404 });

  // Host is client-controlled and hostnames are only unique per-tenant; the
  // POST export below resolves the tenant from it first (withTenantFrom), so
  // this lookup runs already scoped in cloud (RLS) via the ambient `db`.
  const site = await db.site.findFirst({
    where: { hostname },
    select: { id: true, connectorId: true, upstreamUrl: true, insecureSkipVerify: true, recordSessions: true, clipboardMode: true, accessMode: true, watermark: true },
  });
  if (!site) return NextResponse.json({ error: "no_site" }, { status: 404 });

  const recordSessions = await effectiveSiteRecording(site.recordSessions);
  return NextResponse.json({
    siteId: site.id,
    connectorId: site.connectorId,
    upstreamUrl: site.upstreamUrl,
    insecureSkipVerify: site.insecureSkipVerify,
    // Runtime-gated, not just the per-Site toggle: if RECORDING_ENABLED is
    // turned off after a Site was configured to record, the dataplane must
    // stop injecting the recorder script and stripping CSP immediately.
    recordSessions,
    // Clipboard control is web-injection based (transparent only); gateway sites
    // manage clipboard in Guacamole, so never inject for them.
    clipboardMode: site.accessMode === "GATEWAY" ? "allow" : (site.clipboardMode ?? (await resolvedClipboardDefault())),
    accessMode: site.accessMode,
    // DLP watermark for transparent web apps: the data-plane overlays the vendor's
    // email + a live clock on every page (isolated sessions get the same from
    // KasmVNC). Per-site override, else the tenant default.
    watermark: site.accessMode === "TRANSPARENT" && (site.watermark ?? (await resolvedWatermarkDefault())),
    // Global consent-gate policy; only meaningful when this site records.
    recordingConsentRequired: recordSessions ? await resolvedRecordingConsentRequired() : false,
  });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
