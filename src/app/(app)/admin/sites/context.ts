import { db } from "@/lib/db";
import { recordingEnabled } from "@/lib/recording/enabled";
import { nativeGatewayEnabled } from "@/lib/gateway/native";
import { siteHostSuffix } from "@/lib/site/host-suffix";
import { isolationEnabled } from "@/lib/isolation/enabled";
import { expectedServerIp } from "@/lib/site/verify-domain";
import {
  resolvedKeystrokeLoggingMode, resolvedRecordingMode, resolvedGuacParamDefaults, resolvedClipboardDefault, resolvedWatermarkDefault,
  resolvedIsolatedEgressDefault, resolvedIsolatedFileTransferDefault, resolvedWebAppFileTransferDefault,
} from "@/lib/settings/platform";
import type { ResourceContext } from "./resource-form";

/** Everything the add/edit resource dialog needs to show the Policy values and checks. */
export async function resourceContext(): Promise<ResourceContext> {
  const [connectors, recordingMode, keystrokeMode, guacDefaults, clipboardDefault, watermarkDefault, egressDefault, fileTransferDefault, webFileTransferDefault, hostSuffix, customDomainIp] = await Promise.all([
    db.connector.findMany({ where: { status: { not: "REVOKED" } }, select: { id: true, name: true, status: true, vaultPublicKey: true }, orderBy: { name: "asc" } }),
    resolvedRecordingMode(), resolvedKeystrokeLoggingMode(), resolvedGuacParamDefaults(), resolvedClipboardDefault(), resolvedWatermarkDefault(),
    resolvedIsolatedEgressDefault(), resolvedIsolatedFileTransferDefault(), resolvedWebAppFileTransferDefault(), siteHostSuffix(),
    expectedServerIp().catch(() => null),
  ]);
  return {
    connectors: connectors.map((c) => ({ id: c.id, name: c.name, online: c.status === "ONLINE", vaultPublicKey: c.vaultPublicKey })),
    recordingEnabled: recordingEnabled(), recordingMode, keystrokeMode, guacDefaults, clipboardDefault, watermarkDefault, egressDefault,
    fileTransferDefault, webFileTransferDefault, nativeGateway: nativeGatewayEnabled(), isolationEnabled: isolationEnabled(), hostSuffix, customDomainIp,
  };
}
