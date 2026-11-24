import { db } from "@/lib/db";
import { sealsOf } from "@/lib/vault/store";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { activeCheckout } from "@/lib/vault/checkout";
import { canRotate, directoryForRotation, nativeBlocksRotation, rotationMethod, rotationMinConnector, rotationOn, windowsAccountOf, type RotationMethod, type WindowsAccount } from "@/lib/vault/rotation";
import { parseDbParams } from "@/lib/database/params";

// What the resource page shows about rotation, and what the settings API
// checks against. Server-only; nothing here can open a password.

export type RotationStatus = {
  method: RotationMethod | null;
  unsupported: string | null;
  /** A native client on it needs a password the user knows (nativeBlocksRotation). */
  native: boolean;
  /** MySQL or SQL Server with TLS off: the new password crosses the network in the clear when set (SQL Server encrypts only the sign-in). */
  cleartext: boolean;
  afterSession: boolean;
  everyDays: number | null;
  verifyDaily: boolean;
  on: boolean;
  state: string | null;
  detail: string | null;
  rotatedAt: string | null;
  verifiedAt: string | null;
  dueAt: string | null;
  pending: boolean;
  /** Someone has the password checked out now (lib/vault/checkout.ts). */
  checkout: { id: string; who: string; until: string; reason: string } | null;
  /** "hashicorp" or "cyberark" when the credential lives in the customer's own vault (connector/vaultprovider.go). */
  vaultSource: string | null;
  /** RDP: a local account of the server or a domain account, and whether an admin said so. */
  windowsAccount: { account: WindowsAccount; chosen: boolean } | null;
  /** Linux, Windows, a database: this server's reconcile account. AD: the directory's reset account. */
  reconcile: { username: string; kind: "PASSWORD" | "KEY"; missingFor: string[] } | null;
  directoryReset: { username: string; host: string; port: number; missingFor: string[] } | null;
  /** The keys a reconcile account is sealed to (the resource's connectors). */
  keys: { connectorId: string; name: string; key: string }[];
  target: { host: string; port: number; username: string };
  /** Why nothing can rotate it right now (no connector new enough, all offline). */
  waiting: string | null;
  /** The connector that last rotated it: it alone keeps a local copy (show-password). */
  rotatedBy: string | null;
};

export async function rotationStatus(siteId: string): Promise<RotationStatus | null> {
  const c = await db.vaultCredential.findUnique({
    where: { siteId },
    select: {
      protocol: true, secretKind: true, secret: true, dbParams: true, sealedTo: true, extraSeals: true, targetHost: true, targetPort: true, username: true,
      rotateAfterSession: true, rotateEveryDays: true, rotateVerifyDaily: true, rotateDueAt: true, rotatedAt: true, verifiedAt: true,
      rotationState: true, rotationDetail: true, pendingSeals: true, reconcileUsername: true, reconcileKind: true, reconcileSeals: true,
      guacParams: true, rotationAccount: true, secretSource: true,
      site: {
        select: {
          nativeRdp: true, nativeSsh: true, recordSessions: true,
          connector: { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } },
          connectorGroup: { select: { members: { orderBy: { createdAt: "asc" }, select: { connector: { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } } } } } },
        },
      },
    },
  });
  if (!c) return null;
  const last = c.rotatedAt
    ? await db.adminAuditEvent.findFirst({ where: { action: "resource.password_rotate", targetId: siteId }, orderBy: { timestamp: "desc" }, select: { metadata: true } })
    : null;
  const byId = (last?.metadata as { connectorId?: string } | null)?.connectorId;
  const dir = c.protocol === "RDP" ? await directoryForRotation() : null;
  const m = rotationMethod(c, dir);
  const holders = (c.site.connectorGroup ? c.site.connectorGroup.members.map((x) => x.connector) : [c.site.connector]).filter((x) => x.status !== "REVOKED");
  const keyed = holders.filter((h) => h.vaultPublicKey);
  const seals = sealsOf(c);
  const missing = (v: unknown) => {
    const have = v && typeof v === "object" ? Object.keys(v as object) : [];
    return keyed.filter((h) => !have.includes(h.vaultPublicKey!)).map((h) => h.name);
  };
  const holdsCopy = keyed.filter((h) => seals[h.vaultPublicKey!]);
  const waiting = !c.sealedTo ? "The saved password is not sealed to a connector yet."
    : holdsCopy.some((h) => canRotate(h, "method" in m ? m.method : null)) ? null
    : holdsCopy.some((h) => h.status === "ONLINE") ? `The connectors that have this password run a version older than ${rotationMinConnector("method" in m ? m.method : null)}. Update one to rotate it.`
    : "No connector that has this password is online.";
  return {
    method: "method" in m ? m.method : null,
    unsupported: "unsupported" in m ? m.unsupported : null,
    windowsAccount: c.protocol === "RDP" && !c.secretSource ? windowsAccountOf(c) : null,
    vaultSource: c.secretSource,
    checkout: await activeCheckout(siteId).then((a) => (a ? { id: a.id, who: a.userName, until: a.endsAt.toISOString(), reason: a.reason } : null)),
    cleartext: (c.protocol === "MYSQL" || c.protocol === "MSSQL") && parseDbParams(c.dbParams, c.protocol).tls === "disable",
    native: nativeBlocksRotation({ ...c.site, recorded: await effectiveSiteRecording(c.site.recordSessions) }),
    afterSession: c.rotateAfterSession,
    everyDays: c.rotateEveryDays,
    verifyDaily: c.rotateVerifyDaily,
    on: rotationOn(c),
    state: c.rotationState,
    detail: c.rotationDetail,
    rotatedAt: c.rotatedAt?.toISOString() ?? null,
    verifiedAt: c.verifiedAt?.toISOString() ?? null,
    dueAt: c.rotateDueAt?.toISOString() ?? null,
    pending: c.pendingSeals != null,
    reconcile: c.reconcileUsername ? { username: c.reconcileUsername, kind: c.reconcileKind === "KEY" ? "KEY" : "PASSWORD", missingFor: missing(c.reconcileSeals) } : null,
    directoryReset: dir?.resetUsername ? { username: dir.resetUsername, host: dir.host, port: dir.port, missingFor: missing(dir.resetSeals) } : null,
    keys: keyed.map((h) => ({ connectorId: h.id, name: h.name, key: h.vaultPublicKey! })),
    target: { host: c.targetHost, port: c.targetPort, username: c.username },
    waiting,
    rotatedBy: byId ? holders.find((h) => h.id === byId)?.name ?? null : null,
  };
}
