import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { nativeSshBlock, type NativeSshBlock } from "@/lib/gateway/native-ssh";

export type NativeSshTarget =
  | { ok: true; siteName: string; connectorId: string; targetHost: string; targetPort: number }
  | { ok: false; status: number; error: "not_found" | "forbidden" | NativeSshBlock; reason?: string };

/**
 * Whether this user may reach this resource with their own SSH client now, and
 * where it goes. The portal's command and the jump host's channel check both
 * ask this. Runs inside the resource's tenant scope.
 */
export async function nativeSshTarget(userId: string, siteId: string, now: Date): Promise<NativeSshTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      name: true, accessMode: true, nativeSsh: true, recordSessions: true, connectorId: true,
      connector: { select: { version: true } },
      vaultCredential: { select: { protocol: true, targetHost: true, targetPort: true } },
    },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  const cred = site.vaultCredential;
  const block = nativeSshBlock({
    accessMode: site.accessMode, nativeSsh: site.nativeSsh, protocol: cred?.protocol,
    recorded: await effectiveSiteRecording(site.recordSessions), connectorVersion: site.connector.version,
  });
  if (block || !cred) return { ok: false, status: 409, error: block ?? "not_ssh" };
  return { ok: true, siteName: site.name, connectorId: site.connectorId, targetHost: cred.targetHost, targetPort: cred.targetPort };
}
