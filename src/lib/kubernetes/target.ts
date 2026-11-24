import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { getVaultCredential } from "@/lib/vault/store";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { recordingEnabled } from "@/lib/recording/enabled";
import { effectiveKeystrokeLogging } from "@/lib/keystroke/policy";
import { resolvedKeystrokeLoggingMode } from "@/lib/settings/platform";
import { candidatesFor, newestVersion, routeMembers, siteRoutingSelect, type RouteCandidate } from "@/lib/connector/route";
import { kubeBlock, KUBERNETES_MIN_CONNECTOR, parseKubeParams, type KubeBlock, type KubeParams } from "@/lib/kubernetes/params";

export type KubeTarget =
  | {
      ok: true; siteName: string; targetHost: string; targetPort: number; username: string; params: KubeParams;
      impersonateUser: string; impersonateGroups: string[]; connectors: RouteCandidate[]; record: boolean; keystrokeLogging: boolean;
    }
  | { ok: false; status: number; error: "not_found" | "forbidden" | "vault_secret_reenter" | KubeBlock; reason?: string };

/**
 * Whether this user may reach this cluster now, and how: its API server, the
 * service account the connector signs in with (its token sealed to each
 * connector that may carry the requests), who the requests act as, and the
 * resource's rules. The portal's kubeconfig and the proxy's checks both ask
 * this. Runs inside the resource's tenant scope.
 */
export async function kubeTarget(userId: string, siteId: string, now: Date): Promise<KubeTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { name: true, accessMode: true, recordSessions: true, keystrokeLogging: true, ...siteRoutingSelect, vaultCredential: { select: { kubeParams: true } } },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  const block = kubeBlock({ accessMode: site.accessMode, connectorVersion: newestVersion(site) });
  if (block) return { ok: false, status: 409, error: block };
  const cred = await getVaultCredential(siteId);
  if (!cred || !cred.sealedSecret || cred.stale) return { ok: false, status: 409, error: "vault_secret_reenter" };
  const members = routeMembers(site, { minVersion: KUBERNETES_MIN_CONNECTOR, canOpen: (m) => !!m.vaultPublicKey && !!cred.seals[m.vaultPublicKey] }).eligible;
  if (members.length === 0) return { ok: false, status: 409, error: "connector_outdated" };
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const params = parseKubeParams(site.vaultCredential?.kubeParams);
  const record = await effectiveSiteRecording(site.recordSessions);
  return {
    ok: true,
    siteName: site.name,
    targetHost: cred.targetHost,
    targetPort: cred.targetPort,
    username: cred.username,
    params,
    impersonateUser: params.identity === "impersonate" ? (user?.email ?? "") : "",
    impersonateGroups: params.identity === "impersonate" ? params.groups : [],
    connectors: candidatesFor(members, (m) => ({ sealedSecret: (m.vaultPublicKey && cred.seals[m.vaultPublicKey]) || cred.sealedSecret })),
    record,
    keystrokeLogging: effectiveKeystrokeLogging({
      mode: await resolvedKeystrokeLoggingMode(), recordingEnabled: recordingEnabled(),
      recordSessions: record, siteFlag: site.keystrokeLogging,
    }),
  };
}
