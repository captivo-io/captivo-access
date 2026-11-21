import { db } from "@/lib/db";
import { sealsOf } from "@/lib/vault/store";
import { canRotate, directoryForRotation, rotationMethod, rotationOn, ROTATION_MIN_CONNECTOR, type RotationMethod } from "@/lib/vault/rotation";

// What the resource page shows about rotation, and what the settings API
// checks against. Server-only; nothing here can open a password.

export type RotationStatus = {
  method: RotationMethod | null;
  unsupported: string | null;
  native: boolean;
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
  /** Linux: this host's reconcile account. AD: the directory's reset account. */
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
      protocol: true, secretKind: true, secret: true, sealedTo: true, extraSeals: true, targetHost: true, targetPort: true, username: true,
      rotateAfterSession: true, rotateEveryDays: true, rotateVerifyDaily: true, rotateDueAt: true, rotatedAt: true, verifiedAt: true,
      rotationState: true, rotationDetail: true, pendingSeals: true, reconcileUsername: true, reconcileKind: true, reconcileSeals: true,
      site: {
        select: {
          nativeRdp: true, nativeSsh: true,
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
    : holdsCopy.some((h) => canRotate(h)) ? null
    : holdsCopy.some((h) => h.status === "ONLINE") ? `The connectors that have this password run a version older than ${ROTATION_MIN_CONNECTOR}. Update one to rotate it.`
    : "No connector that has this password is online.";
  return {
    method: "method" in m ? m.method : null,
    unsupported: "unsupported" in m ? m.unsupported : null,
    native: c.site.nativeRdp || c.site.nativeSsh,
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
