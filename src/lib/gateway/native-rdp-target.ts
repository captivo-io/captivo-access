import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { resolvedClipboardDefault, resolvedGuacParamDefaults } from "@/lib/settings/platform";
import { parseGuacParams, resolveGuacParams } from "@/lib/gateway/guac-params";
import { nativeRdpBlock, nativeRedirection, type NativeRdpBlock, type NativeRedirection } from "@/lib/gateway/native-rdp";

export type NativeRdpTarget =
  | { ok: true; siteName: string; connectorId: string; targetHost: string; targetPort: number; redirection: NativeRedirection }
  | { ok: false; status: number; error: "not_found" | "forbidden" | NativeRdpBlock; reason?: string };

/**
 * Whether this user may open this resource in a native RDP client now, and
 * where it goes. The .rdp download and the gateway's tunnel check both ask
 * this, so a file is only handed out for a tunnel that would be allowed.
 * Runs inside the resource's tenant scope.
 */
export async function nativeRdpTarget(userId: string, siteId: string, now: Date): Promise<NativeRdpTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      name: true, accessMode: true, nativeRdp: true, recordSessions: true, clipboardMode: true, connectorId: true,
      connector: { select: { version: true } },
      vaultCredential: { select: { protocol: true, targetHost: true, targetPort: true, guacParams: true } },
    },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  const cred = site.vaultCredential;
  const block = nativeRdpBlock({
    accessMode: site.accessMode, nativeRdp: site.nativeRdp, protocol: cred?.protocol,
    recorded: await effectiveSiteRecording(site.recordSessions), connectorVersion: site.connector.version,
  });
  if (block || !cred) return { ok: false, status: 409, error: block ?? "not_rdp" };
  const clipboardMode = site.clipboardMode ?? (await resolvedClipboardDefault());
  const guac = resolveGuacParams(parseGuacParams(cred.guacParams), await resolvedGuacParamDefaults());
  return {
    ok: true, siteName: site.name, connectorId: site.connectorId,
    targetHost: cred.targetHost, targetPort: cred.targetPort,
    redirection: nativeRedirection(clipboardMode, guac),
  };
}
