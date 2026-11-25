import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { effectiveSiteRecording, recordingRequired } from "@/lib/recording/effective";
import { recordingEnabled } from "@/lib/recording/enabled";
import { effectiveKeystrokeLogging } from "@/lib/keystroke/policy";
import { resolvedGuacParamDefaults, resolvedKeystrokeLoggingMode } from "@/lib/settings/platform";
import { parseGuacParams, resolveGuacParams } from "@/lib/gateway/guac-params";
import { getVaultCredential } from "@/lib/vault/store";
import { rotationOn } from "@/lib/vault/rotation";
import { SSH_CA_MIN_CONNECTOR } from "@/lib/vault/providers";
import { compareSemver } from "@/lib/updates/semver";
import { ELEVATE_MIN_CONNECTOR } from "@/lib/vault/elevation";
import { isSshCa, type SshCaBlock } from "@/lib/vault/ssh-ca";
import { nativeSshMode, NATIVE_SSH_MIN_CONNECTOR, NATIVE_SSH_RECORDED_MIN_CONNECTOR, type NativeSshBlock, type NativeSshMode } from "@/lib/gateway/native-ssh";
import { candidatesFor, newestVersion, routeMembers, siteRoutingSelect, type RouteCandidate } from "@/lib/connector/route";
import { TUNNEL_MIN_CONNECTOR, tunnelBlock, type TunnelBlock } from "@/lib/gateway/tcp-tunnel";
import { moderationBlock, moderationRequired } from "@/lib/moderation/rules";

/** What a recorded session needs on top of where the server is. */
export type NativeSshRecorded = {
  keystrokeLogging: boolean;
  /** allow | no_upload | no_download | none, from the resource's file transfer settings. */
  fileTransfer: "allow" | "no_upload" | "no_download" | "none";
  username: string;
  secretKind: string;
  /** A legacy secret (no connector vault key); otherwise each candidate carries its seal. */
  secret?: string;
  sshHostKey: string | null;
  /** Administrator rights for this session: the account that adds and removes the sudo entry. Each connector's seal is in its candidate. */
  elevate?: { username: string; kind: string };
  /** "captivo:<e-mail>": the key id of a certificate sign-in, which the server logs. */
  keyId: string;
};

export type NativeSshTarget =
  | ({ ok: true; mode: NativeSshMode | "tunnel"; siteName: string; connectorId: string; connectors: RouteCandidate[]; targetHost: string; targetPort: number; moderated?: boolean } & Partial<NativeSshRecorded>)
  | { ok: false; status: number; error: "not_found" | "forbidden" | "vault_secret_reenter" | "rotated" | "moderator_needs_recording" | "elevate_reenter" | SshCaBlock | NativeSshBlock | TunnelBlock; reason?: string };

/** The resource's file transfer rule, as its browser SSH session would have it. */
export function sshFileTransfer(p: { enableFileTransfer?: boolean; blockUpload?: boolean; blockDownload?: boolean }): NativeSshRecorded["fileTransfer"] {
  if (!p.enableFileTransfer) return "none";
  if (p.blockUpload && p.blockDownload) return "none";
  if (p.blockUpload) return "no_upload";
  if (p.blockDownload) return "no_download";
  return "allow";
}

/**
 * Whether this user may reach this resource with their own SSH client now, and
 * where it goes. The portal's command and the jump host's channel check both
 * ask this. A recorded resource also carries the sign-in the connector makes
 * (sealed to each connector) and what the session may do. Runs inside the
 * resource's tenant scope.
 */
export async function nativeSshTarget(userId: string, siteId: string, now: Date): Promise<NativeSshTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      name: true, accessMode: true, nativeSsh: true, recordSessions: true, requireModerator: true, keystrokeLogging: true, tunnelHost: true, tunnelPort: true, ...siteRoutingSelect,
      vaultCredential: { select: { protocol: true, targetHost: true, targetPort: true, sshHostKey: true, rotateAfterSession: true, rotateEveryDays: true, secretSource: true, elevate: true, reconcileUsername: true, reconcileKind: true, reconcileSeals: true } },
    },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  if (site.accessMode === "TUNNEL") {
    // A TCP tunnel: the jump host forwards the command's connections to the service (lib/gateway/tcp-tunnel.ts).
    const block = tunnelBlock({ accessMode: site.accessMode, recordingRequired: await recordingRequired(), connectorVersion: newestVersion(site) });
    if (block) return { ok: false, status: 409, error: block };
    if (!site.tunnelHost || !site.tunnelPort) return { ok: false, status: 409, error: "not_ssh" };
    const members = routeMembers(site, { minVersion: TUNNEL_MIN_CONNECTOR }).eligible;
    if (members.length === 0) return { ok: false, status: 409, error: "connector_outdated" };
    return { ok: true, mode: "tunnel", siteName: site.name, targetHost: site.tunnelHost, targetPort: site.tunnelPort, connectorId: members[0].id, connectors: candidatesFor(members) };
  }
  const cred = site.vaultCredential;
  const recorded = await effectiveSiteRecording(site.recordSessions);
  const mode = nativeSshMode({
    accessMode: site.accessMode, nativeSsh: site.nativeSsh, protocol: cred?.protocol, recorded,
    recordingRequired: await recordingRequired(), connectorVersion: newestVersion(site),
  });
  if (mode !== "recorded" && mode !== "direct") return { ok: false, status: 409, error: mode };
  if (!cred) return { ok: false, status: 409, error: "not_ssh" };
  // A certificate sign-in is the connector's own: only the recorded path has one (recording switched off afterwards ends up here).
  if (isSshCa(cred) && mode !== "recorded") return { ok: false, status: 409, error: "ssh_ca_needs_recording" };
  // A resource on one connector is never filtered by version below, and an older connector would try to read the reference as a vault address.
  if (isSshCa(cred) && compareSemver(newestVersion(site), SSH_CA_MIN_CONNECTOR) === -1) return { ok: false, status: 409, error: "connector_outdated" };
  // A moderator must be able to watch: only a recorded session passes the jump host's view.
  const moderated = moderationRequired(site);
  if (moderated && moderationBlock("native_ssh", mode === "recorded")) return { ok: false, status: 409, error: "moderator_needs_recording" };
  const where = { siteName: site.name, targetHost: cred.targetHost, targetPort: cred.targetPort };

  if (mode === "direct") {
    // The user would sign in with a password Captivo rotates and nobody knows.
    // Saving refuses this; it happens when recording is switched off afterwards.
    if (rotationOn(cred)) return { ok: false, status: 409, error: "rotated" };
    // On a group, only members new enough to relay the tunnel carry it.
    const members = routeMembers(site, { minVersion: NATIVE_SSH_MIN_CONNECTOR }).eligible;
    if (members.length === 0) return { ok: false, status: 409, error: "connector_outdated" };
    return { ok: true, mode, ...where, connectorId: members[0].id, connectors: candidatesFor(members) };
  }

  const vault = await getVaultCredential(siteId);
  if (!vault) return { ok: false, status: 409, error: "not_ssh" };
  if (vault.stale) return { ok: false, status: 409, error: "vault_secret_reenter" };
  const sealed = !!vault.sealedSecret;
  const sealFor = (m: { vaultPublicKey: string | null }) => (m.vaultPublicKey ? vault.seals[m.vaultPublicKey] : undefined) ?? vault.sealedSecret;
  const members = routeMembers(site, {
    minVersion: isSshCa(cred) ? SSH_CA_MIN_CONNECTOR : NATIVE_SSH_RECORDED_MIN_CONNECTOR,
    ...(sealed ? { canOpen: (m: { vaultPublicKey: string | null }) => !!m.vaultPublicKey && !!vault.seals[m.vaultPublicKey] } : {}),
  }).eligible;
  if (members.length === 0) return { ok: false, status: 409, error: sealed ? "vault_secret_reenter" : "connector_outdated" };
  // Administrator rights: a connector new enough, holding the administrator account's seal.
  const elevSeals = cred.elevate && cred.reconcileSeals && typeof cred.reconcileSeals === "object" && !Array.isArray(cred.reconcileSeals) ? (cred.reconcileSeals as Record<string, string>) : {};
  let carriers = members;
  if (cred.elevate) {
    if (!cred.reconcileUsername) return { ok: false, status: 409, error: "elevate_reenter" };
    if (compareSemver(newestVersion(site), ELEVATE_MIN_CONNECTOR) === -1) return { ok: false, status: 409, error: "connector_outdated" };
    carriers = members.filter((m) => compareSemver(m.version, ELEVATE_MIN_CONNECTOR) !== -1 && !!m.vaultPublicKey && !!elevSeals[m.vaultPublicKey]);
    if (carriers.length === 0) return { ok: false, status: 409, error: "elevate_reenter" };
  }
  const who = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const params = resolveGuacParams(parseGuacParams(vault.guacParams), await resolvedGuacParamDefaults());
  return {
    ok: true, mode, ...where, moderated,
    connectorId: carriers[0].id,
    connectors: candidatesFor(carriers, (m) => ({ ...(sealed ? { sealedSecret: sealFor(m) } : {}), ...(cred.elevate && m.vaultPublicKey ? { elevateSealed: elevSeals[m.vaultPublicKey] } : {}) })),
    ...(cred.elevate ? { elevate: { username: cred.reconcileUsername!, kind: cred.reconcileKind === "KEY" ? "KEY" : "PASSWORD" } } : {}),
    keystrokeLogging: effectiveKeystrokeLogging({
      mode: await resolvedKeystrokeLoggingMode(), recordingEnabled: recordingEnabled(),
      recordSessions: true, siteFlag: site.keystrokeLogging,
    }),
    fileTransfer: sshFileTransfer(params),
    username: vault.username,
    secretKind: vault.secretKind,
    ...(sealed ? {} : { secret: vault.secret ?? "" }),
    sshHostKey: cred.sshHostKey,
    keyId: `captivo:${who?.email ?? userId}`,
  };
}
