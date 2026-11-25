import { db } from "@/lib/db";
import { moderationRequired } from "@/lib/moderation/rules";
import { evaluateAccess } from "@/lib/access/evaluate";
import { effectiveSiteRecording, recordingRequired } from "@/lib/recording/effective";
import { resolvedClipboardDefault, resolvedGuacParamDefaults, resolvedKeystrokeLoggingMode } from "@/lib/settings/platform";
import { recordingEnabled } from "@/lib/recording/enabled";
import { effectiveKeystrokeLogging } from "@/lib/keystroke/policy";
import { parseGuacParams, resolveGuacParams } from "@/lib/gateway/guac-params";
import { getVaultCredential } from "@/lib/vault/store";
import { rotationOn } from "@/lib/vault/rotation";
import { elevationAccountName, elevationPlan } from "@/lib/vault/elevation";
import { blockedChannels, nativeRdpMode, NATIVE_RDP_MIN_CONNECTOR, NATIVE_RDP_RECORDED_MIN_CONNECTOR, nativeRedirection, type NativeRdpBlock, type NativeRdpMode, type NativeRedirection } from "@/lib/gateway/native-rdp";
import { candidatesFor, newestVersion, routeMembers, siteRoutingSelect, type RouteCandidate } from "@/lib/connector/route";

/** What a recorded session needs on top of where the server is. */
export type NativeRdpRecorded = {
  /** Administrator rights for this session: the account that gives them. Each connector's seal is in its candidate. */
  elevate?: { platform: string; username: string; kind: string; account?: string };
  keystrokeLogging: boolean;
  username: string;
  /** A legacy secret (no connector vault key); otherwise each candidate carries its seal. */
  secret?: string;
  blockChannels: string[];
};

export type NativeRdpTarget =
  | ({ ok: true; mode: NativeRdpMode; siteName: string; connectorId: string; connectors: RouteCandidate[]; targetHost: string; targetPort: number; redirection: NativeRedirection } & Partial<NativeRdpRecorded>)
  | { ok: false; status: number; error: "not_found" | "forbidden" | "vault_secret_reenter" | "rotated" | "moderator_browser_only" | "elevate_reenter" | NativeRdpBlock; reason?: string };

/**
 * Whether this user may open this resource in a native RDP client now, and
 * where it goes. The .rdp download and the gateway's tunnel check both ask
 * this, so a file is only handed out for a tunnel that would be allowed. A
 * recorded resource also carries the account the connector signs in with
 * (sealed to each connector). Runs inside the resource's tenant scope.
 */
export async function nativeRdpTarget(userId: string, siteId: string, now: Date): Promise<NativeRdpTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      name: true, accessMode: true, nativeRdp: true, recordSessions: true, requireModerator: true, keystrokeLogging: true, clipboardMode: true, ...siteRoutingSelect,
      vaultCredential: { select: { protocol: true, targetHost: true, targetPort: true, guacParams: true, rotateAfterSession: true, rotateEveryDays: true, elevate: true, reconcileUsername: true, reconcileKind: true, reconcileSeals: true } },
    },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  // A moderator can't watch over a user's own Remote Desktop app yet: browser sessions only.
  if (moderationRequired(site)) return { ok: false, status: 409, error: "moderator_browser_only" };
  const cred = site.vaultCredential;
  const mode = nativeRdpMode({
    accessMode: site.accessMode, nativeRdp: site.nativeRdp, protocol: cred?.protocol,
    recorded: await effectiveSiteRecording(site.recordSessions),
    recordingRequired: await recordingRequired(), connectorVersion: newestVersion(site),
  });
  if (mode !== "recorded" && mode !== "direct") return { ok: false, status: 409, error: mode };
  if (!cred) return { ok: false, status: 409, error: "not_rdp" };
  const clipboardMode = site.clipboardMode ?? (await resolvedClipboardDefault());
  const guac = resolveGuacParams(parseGuacParams(cred.guacParams), await resolvedGuacParamDefaults());
  const redirection = nativeRedirection(clipboardMode, guac);
  const where = { siteName: site.name, targetHost: cred.targetHost, targetPort: cred.targetPort, redirection };

  if (mode === "direct") {
    // The user would sign in with a password Captivo rotates and nobody knows.
    // Saving refuses this; it happens when recording is switched off afterwards.
    if (rotationOn(cred)) return { ok: false, status: 409, error: "rotated" };
    // On a group, only members new enough to relay the tunnel carry it.
    const members = routeMembers(site, { minVersion: NATIVE_RDP_MIN_CONNECTOR }).eligible;
    if (members.length === 0) return { ok: false, status: 409, error: "connector_outdated" };
    return { ok: true, mode, ...where, connectorId: members[0].id, connectors: candidatesFor(members) };
  }

  const vault = await getVaultCredential(siteId);
  if (!vault) return { ok: false, status: 409, error: "not_rdp" };
  if (vault.stale) return { ok: false, status: 409, error: "vault_secret_reenter" };
  const sealed = !!vault.sealedSecret;
  const sealFor = (m: { vaultPublicKey: string | null }) => (m.vaultPublicKey ? vault.seals[m.vaultPublicKey] : undefined) ?? vault.sealedSecret;
  const members = routeMembers(site, {
    minVersion: NATIVE_RDP_RECORDED_MIN_CONNECTOR,
    ...(sealed ? { canOpen: (m: { vaultPublicKey: string | null }) => !!m.vaultPublicKey && !!vault.seals[m.vaultPublicKey] } : {}),
  }).eligible;
  if (members.length === 0) return { ok: false, status: 409, error: sealed ? "vault_secret_reenter" : "connector_outdated" };
  // Administrator rights for this session: connectors new enough that hold the administrator account's seal.
  const plan = elevationPlan(cred, members, "session");
  if (plan.on && !plan.ok) return { ok: false, status: 409, error: plan.error };
  const carriers = plan.on ? plan.carriers : members;
  return {
    ok: true, mode, ...where,
    connectorId: carriers[0].id,
    connectors: candidatesFor(carriers, (m) => ({ ...(sealed ? { sealedSecret: sealFor(m) } : {}), ...(plan.on && plan.ok ? { elevateSealed: plan.sealOf(m) } : {}) })),
    ...(plan.on && plan.ok ? { elevate: { ...plan.elevate, account: elevationAccountName(cred.protocol, vault.username, cred.guacParams) } } : {}),
    keystrokeLogging: effectiveKeystrokeLogging({
      mode: await resolvedKeystrokeLoggingMode(), recordingEnabled: recordingEnabled(),
      recordSessions: true, siteFlag: site.keystrokeLogging,
    }),
    username: vault.username,
    ...(sealed ? {} : { secret: vault.secret ?? "" }),
    blockChannels: blockedChannels(redirection),
  };
}
