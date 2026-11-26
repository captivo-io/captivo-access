import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { expectedServerIp } from "@/lib/site/verify-domain";
import {
  resolvedKeystrokeLoggingMode, resolvedRecordingMode, resolvedGuacParamDefaults, resolvedClipboardDefault, resolvedWatermarkDefault,
  resolvedIsolatedEgressDefault, resolvedIsolatedFileTransferDefault, resolvedWebAppFileTransferDefault, resolvedRevealRequiresReason,
} from "@/lib/settings/platform";
import { moderatorCount } from "@/lib/moderation/requests";
import type { ResourceContext } from "./resource-form";

/** Everything the add/edit resource dialog needs to show the Policy values and checks. */
export async function resourceContext(): Promise<ResourceContext> {
  const [connectors, groups, recordingMode, keystrokeMode, guacDefaults, clipboardDefault, watermarkDefault, egressDefault, fileTransferDefault, webFileTransferDefault, hostSuffix, customDomainIp, moderators, revealRequiresReason] = await Promise.all([
    db.connector.findMany({ where: { status: { not: "REVOKED" } }, select: { id: true, name: true, status: true, vaultPublicKey: true, sshCaPublicKey: true, version: true, platform: true }, orderBy: { name: "asc" } }),
    db.connectorGroup.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, members: { where: { connector: { status: { not: "REVOKED" } } }, orderBy: [{ standby: "asc" }, { createdAt: "asc" }], select: { standby: true, connector: { select: { id: true, name: true, status: true, vaultPublicKey: true, sshCaPublicKey: true, version: true, platform: true } } } } },
    }),
    resolvedRecordingMode(), resolvedKeystrokeLoggingMode(), resolvedGuacParamDefaults(), resolvedClipboardDefault(), resolvedWatermarkDefault(),
    resolvedIsolatedEgressDefault(), resolvedIsolatedFileTransferDefault(), resolvedWebAppFileTransferDefault(), siteHostSuffix(),
    expectedServerIp().catch(() => null), moderatorCount(), resolvedRevealRequiresReason(),
  ]);
  return {
    connectors: connectors.map((c) => ({ id: c.id, name: c.name, online: c.status === "ONLINE", vaultPublicKey: c.vaultPublicKey, sshCaPublicKey: c.sshCaPublicKey, version: c.version, platform: c.platform })),
    groups: groups.filter((g) => g.members.length > 0).map((g) => ({
      id: g.id, name: g.name,
      members: g.members.map(({ standby, connector: c }) => ({ id: c.id, name: c.name, online: c.status === "ONLINE", standby, vaultPublicKey: c.vaultPublicKey, sshCaPublicKey: c.sshCaPublicKey, version: c.version, platform: c.platform })),
    })),
    recordingEnabled: recordingEnabled(), recordingMode, keystrokeMode, guacDefaults, clipboardDefault, watermarkDefault, egressDefault,
    fileTransferDefault, webFileTransferDefault, nativeGateway: nativeGatewayEnabled(), isolationEnabled: isolationEnabled(), hostSuffix, customDomainIp, moderators, revealRequiresReason,
  };
}
