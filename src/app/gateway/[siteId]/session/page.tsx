import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { resolvedRecordingConsentRequired, resolvedClipboardDefault, resolvedIsolatedFileTransferDefault, resolvedWatermarkDefault } from "@/lib/settings/platform";
import type { GatewayProtocol } from "@/lib/gateway/paste-keys";
import { GatewaySession } from "./session-client";
import { IsolatedSession } from "./isolated-client";
import { ConsentGate } from "./consent-gate";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Session" };

// Top-level route (outside the (app) shell) so the session is the ONLY thing on
// screen — no header, no sidebar, full viewport.
async function GatewaySessionPageImpl({ params }: { params: Promise<{ siteId: string }> }) {
  const user = await requireUser();
  const { siteId } = await params;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { accessMode: true, name: true, recordSessions: true, clipboardMode: true, fileTransferMode: true, watermark: true } });
  // This full-screen session page serves native GATEWAY (RDP/SSH/VNC) and ISOLATED
  // (remote browser) resources — both stream a screen via guacd. Everything else
  // (or a disabled capability) has no session here.
  const okGateway = nativeGatewayEnabled() && site?.accessMode === "GATEWAY";
  const okIsolated = isolationEnabled() && site?.accessMode === "ISOLATED";
  if (!site || (!okGateway && !okIsolated)) {
    notFound();
  }
  const recorded = await effectiveSiteRecording(site.recordSessions);
  // Ask for recording consent once per browser session (matches web sessions):
  // skip the gate if the vendor already acknowledged this resource this session.
  const alreadyConsented = (await cookies()).get(`ca_rec_consent_${siteId}`)?.value === "1";
  const consentNeeded = recorded && !alreadyConsented && (await resolvedRecordingConsentRequired());
  // Past the okGateway/okIsolated guards, accessMode is GATEWAY or ISOLATED; narrow
  // the Prisma enum (which also has TRANSPARENT) to the union the viewers expect.
  const mode = site.accessMode === "ISOLATED" ? "ISOLATED" : "GATEWAY";
  // Resolve the inherit sentinel (null) to a concrete mode server-side so the
  // client's clipboard caps mirror the same policy guacd enforces.
  const clipboardMode = site.clipboardMode ?? (await resolvedClipboardDefault());
  const fileTransferMode = site.fileTransferMode ?? (await resolvedIsolatedFileTransferDefault());
  // Remote desktop: the watermark is laid over the page here (shell/watermark.tsx);
  // the isolated browser draws its own (KasmVNC, from the descriptor).
  const watermarkText = mode === "GATEWAY" && (site.watermark ?? (await resolvedWatermarkDefault())) ? user.email : null;
  // The remote's paste chord differs per protocol (terminal vs desktop).
  const cred = mode === "GATEWAY" ? await db.vaultCredential.findUnique({ where: { siteId }, select: { protocol: true } }) : null;
  const protocol: GatewayProtocol = cred?.protocol === "SSH" || cred?.protocol === "VNC" ? cred.protocol : "RDP";
  if (consentNeeded) {
    return <ConsentGate accessMode={mode} siteId={siteId} siteName={site.name} recorded={recorded} clipboardMode={clipboardMode} fileTransferMode={fileTransferMode} protocol={protocol} watermarkText={watermarkText} />;
  }
  return mode === "ISOLATED"
    ? <IsolatedSession siteId={siteId} siteName={site.name} recorded={recorded} fileTransferMode={fileTransferMode} />
    : <GatewaySession siteId={siteId} siteName={site.name} recorded={recorded} clipboardMode={clipboardMode} protocol={protocol} watermarkText={watermarkText} />;
}

export default async function GatewaySessionPage(...args: Parameters<typeof GatewaySessionPageImpl>) {
  return withRequestTenant(() => GatewaySessionPageImpl(...args));
}
