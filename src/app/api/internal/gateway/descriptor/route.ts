import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/secure-compare";
import { evaluateAccess } from "@/lib/access/evaluate";
import { getVaultCredential } from "@/lib/vault/store";
import { recordingEnabled } from "@/lib/recording/enabled";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { resolvedWatermarkDefault, resolvedClipboardDefault, resolvedGuacParamDefaults, resolvedKeystrokeLoggingMode } from "@/lib/settings/platform";
import { effectiveKeystrokeLogging } from "@/lib/keystroke/policy";
import { currentTenantId } from "@/lib/tenant/context";
import { parseGuacParams, resolveGuacParams, toGuacArgs } from "@/lib/gateway/guac-params";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { db } from "@/lib/db";
import { requireDataplaneSecret, resolveTenantBySite, withTenantFrom } from "@/lib/tenant/internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dpAuthorized(req: NextRequest): boolean {
  const s = process.env.DATAPLANE_SECRET;
  return !!s && timingSafeEqualStr(req.headers.get("x-dataplane-secret"), s);
}

async function tenantFromReq(req: NextRequest): Promise<string | null> {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return resolveTenantBySite(typeof body.siteId === "string" ? body.siteId : "");
}

// The data-plane guac-tunnel calls this per session: it authorizes (grant) and
// returns the decrypted connection descriptor to inject into the guacd handshake.
// The plaintext secret leaves the manager only over this DATAPLANE_SECRET-gated,
// internal-only channel.
async function handler(req: NextRequest) {
  if (!dpAuthorized(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = typeof b.userId === "string" ? b.userId : "";
  const siteId = typeof b.siteId === "string" ? b.siteId : "";
  if (!userId || !siteId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const site = await db.site.findUnique({ where: { id: siteId }, select: { accessMode: true, connectorId: true, recordSessions: true, clipboardMode: true, upstreamUrl: true, watermark: true, fileTransferMode: true, keystrokeLogging: true, insecureSkipVerify: true } });
  if (!site || (site.accessMode !== "GATEWAY" && site.accessMode !== "ISOLATED")) return NextResponse.json({ error: "not_gateway" }, { status: 404 });

  const decision = await evaluateAccess(userId, siteId, new Date());
  if (!decision.allow) return NextResponse.json({ error: "forbidden", reason: decision.reason }, { status: 403 });

  // Resolve the inherit sentinel (null) to a concrete mode server-side, so the
  // data-plane and browser never see "inherit".
  const clipboardMode = site.clipboardMode ?? (await resolvedClipboardDefault());
  // Tenant recordingMode policy applied on top of the global RECORDING_ENABLED
  // capability and this resource's own toggle — same resolution both routes below use.
  const record = await effectiveSiteRecording(site.recordSessions);

  if (site.accessMode === "ISOLATED") {
    if (!isolationEnabled()) return NextResponse.json({ error: "isolation_disabled" }, { status: 404 });
    // DLP watermark (live-view): vendor email + live UTC clock, rendered by KasmVNC to
    // every client. Resolve per-site override against the global default.
    const watermarkOn = site.watermark ?? (await resolvedWatermarkDefault());
    let watermarkText = "";
    if (watermarkOn) {
      const u = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
      const who = u?.email ?? "";
      if (who) watermarkText = who + "  %Y-%m-%d %H:%M UTC";
    }
    return NextResponse.json({
      transport: "kasm",
      navigateUrl: site.upstreamUrl ?? "",
      tenantId: currentTenantId(),
      kasmAddr: (process.env.ISOLATED_KASM_ADDR ?? "captivo-kasm:6901").trim(),
      kasmControlAddr: (process.env.ISOLATED_KASM_CONTROL_ADDR ?? "captivo-kasm:7900").trim(),
      connectorId: site.connectorId,
      clipboardMode,
      record,
      watermarkText,
      fileTransferMode: site.fileTransferMode,
      insecureSkipVerify: site.insecureSkipVerify,
    });
  }

  const cred = await getVaultCredential(siteId);
  if (!cred) return NextResponse.json({ error: "no_credential" }, { status: 404 });

  const resolved = resolveGuacParams(parseGuacParams(cred.guacParams), await resolvedGuacParamDefaults());
  const params = toGuacArgs(resolved, clipboardMode, cred.protocol as "RDP" | "SSH" | "VNC", cred.username);

  return NextResponse.json({
    tenantId: currentTenantId(),
    protocol: cred.protocol.toLowerCase(),
    params,
    targetHost: cred.targetHost,
    targetPort: cred.targetPort,
    username: cred.username,
    secret: cred.secret,
    secretKind: cred.secretKind,
    guacdAddress: (process.env.GUACD_ADDR ?? "captivo-guacd:4822").trim(),
    connectorId: site.connectorId,
    record,
    keystrokeLogging: effectiveKeystrokeLogging({
      mode: await resolvedKeystrokeLoggingMode(),
      recordingEnabled: recordingEnabled(),
      recordSessions: site.recordSessions,
      siteFlag: site.keystrokeLogging,
    }),
  });
}

export const POST = requireDataplaneSecret(withTenantFrom(tenantFromReq)(handler));
