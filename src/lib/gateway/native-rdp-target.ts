import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { recordingRequired } from "@/lib/recording/effective";
import { resolvedClipboardDefault, resolvedGuacParamDefaults } from "@/lib/settings/platform";
import { parseGuacParams, resolveGuacParams } from "@/lib/gateway/guac-params";
import { nativeRdpBlock, NATIVE_RDP_MIN_CONNECTOR, nativeRedirection, type NativeRdpBlock, type NativeRedirection } from "@/lib/gateway/native-rdp";
import { candidatesFor, newestVersion, routeMembers, siteRoutingSelect, type RouteCandidate } from "@/lib/connector/route";

export type NativeRdpTarget =
  | { ok: true; siteName: string; connectorId: string; connectors: RouteCandidate[]; targetHost: string; targetPort: number; redirection: NativeRedirection }
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
      name: true, accessMode: true, nativeRdp: true, recordSessions: true, clipboardMode: true, ...siteRoutingSelect,
      vaultCredential: { select: { protocol: true, targetHost: true, targetPort: true, guacParams: true } },
    },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  const cred = site.vaultCredential;
  const block = nativeRdpBlock({
    accessMode: site.accessMode, nativeRdp: site.nativeRdp, protocol: cred?.protocol,
    recordingRequired: await recordingRequired(), connectorVersion: newestVersion(site),
  });
  if (block || !cred) return { ok: false, status: 409, error: block ?? "not_rdp" };
  // On a group, only members new enough to relay the tunnel carry it.
  const members = routeMembers(site, { minVersion: NATIVE_RDP_MIN_CONNECTOR }).eligible;
  if (members.length === 0) return { ok: false, status: 409, error: "connector_outdated" };
  const clipboardMode = site.clipboardMode ?? (await resolvedClipboardDefault());
  const guac = resolveGuacParams(parseGuacParams(cred.guacParams), await resolvedGuacParamDefaults());
  return {
    ok: true, siteName: site.name, connectorId: members[0].id, connectors: candidatesFor(members),
    targetHost: cred.targetHost, targetPort: cred.targetPort,
    redirection: nativeRedirection(clipboardMode, guac),
  };
}
