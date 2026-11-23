import { dbEngineOf, MSSQL_MIN_CONNECTOR, parseDbParams } from "@/lib/database/params";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";
import { compareSemver } from "@/lib/updates/semver";
import { isSealedValue } from "@/lib/vault/seal";
import { sealsOf, splitSeals, storedSecretColumns } from "@/lib/vault/store";
import { recordAdminAction, type AdminActor } from "@/lib/audit/admin";
import { recordConnectorEvent } from "@/lib/connector/history";
import { pushToCapability } from "@/lib/mobile/push";
import { consoleBaseUrl } from "@/lib/tenant/console-url";

// Password rotation: a connector that serves the resource generates the next
// password, changes it on the target and seals it to every connector key that
// serves the resource (connector/rotate.go). This side decides WHEN, keeps the
// sealed values, and records what happened; it never holds a password it can
// open.
//
// The order is what keeps an account from being locked out: the prepared
// password's seals are stored as "pending" before the target is touched, and
// they become the saved password only once the connector has seen the target
// take them. An answer that never comes leaves both, and the next attempt asks
// the target which one it uses.
//
// Like the group copies (reshare.ts), each pass is plan (DB) → work (network,
// unscoped: a change takes seconds and the tenant scope is a transaction) →
// save (DB), with the save conditional on the saved password not having been
// re-entered meanwhile.

/** The first connector release that rotates passwords. */
export const ROTATION_MIN_CONNECTOR = "2.45.0";
/** Database accounts (PostgreSQL, MySQL) rotate from this release on; SQL Server logins from MSSQL_MIN_CONNECTOR, the release that has it. */
export const DB_ROTATION_MIN_CONNECTOR = "2.54.0";

/** After the last session ends, before the password changes (a quick reconnect keeps it). */
export const AFTER_SESSION_DELAY_MS = 60_000;

const DAY_MS = 86_400_000;

/** Retry waits after consecutive failures: 5 min, 15 min, 1 h, then every 6 h. */
export function retryDelayMs(failures: number): number {
  const steps = [5 * 60_000, 15 * 60_000, 60 * 60_000];
  return failures <= 0 ? 0 : steps[failures - 1] ?? 6 * 60 * 60_000;
}

export type RotationMethod = "linux" | "ad" | "postgres" | "mysql" | "mssql";

export const isDbMethod = (m: RotationMethod | null | undefined) => m === "postgres" || m === "mysql" || m === "mssql";

/** The connector release a method needs. */
export function rotationMinConnector(m?: RotationMethod | null): string {
  return m === "mssql" ? MSSQL_MIN_CONNECTOR : isDbMethod(m) ? DB_ROTATION_MIN_CONNECTOR : ROTATION_MIN_CONNECTOR;
}

export type DirectoryForRotation = {
  enabled: boolean; host: string; port: number; security: string; caCertPem: string; insecureSkipVerify: boolean; baseDN: string;
  resetUsername: string; resetSeals: unknown;
};

/** How this resource's account is rotated, or why it cannot be. */
export function rotationMethod(c: { protocol: string; secretKind: string }, dir: DirectoryForRotation | null): { method: RotationMethod } | { unsupported: string } {
  if (c.secretKind !== "PASSWORD") return { unsupported: "Only passwords are rotated, not SSH keys." };
  if (c.protocol === "SSH") return { method: "linux" };
  if (c.protocol === "RDP") {
    if (!dir || !dir.host || !dir.baseDN) return { unsupported: "An RDP account is rotated in Active Directory. Set up the directory first (Settings › Directory)." };
    if (dir.security !== "LDAPS" && dir.security !== "STARTTLS") return { unsupported: "Active Directory changes passwords only over an encrypted connection. Set the directory to LDAPS or StartTLS." };
    return { method: "ad" };
  }
  if (c.protocol === "POSTGRES") return { method: "postgres" };
  if (c.protocol === "MYSQL") return { method: "mysql" };
  if (c.protocol === "MSSQL") return { method: "mssql" };
  return { unsupported: "VNC passwords are not rotated." };
}

export function canRotate(c: { status: string; version: string | null }, method?: RotationMethod | null): boolean {
  return c.status === "ONLINE" && !!c.version && compareSemver(c.version, rotationMinConnector(method)) !== -1;
}

export function rotationOn(c: { rotateAfterSession: boolean; rotateEveryDays: number | null }): boolean {
  return c.rotateAfterSession || c.rotateEveryDays != null;
}

/**
 * A native client the user signs in to themselves needs a password they know,
 * which rotation takes away. A recorded native session (SSH or RDP) is signed
 * in by Captivo with the saved password, so rotation can stay on there.
 */
export function nativeBlocksRotation(s: { nativeRdp: boolean; nativeSsh: boolean; recorded: boolean }): boolean {
  return (s.nativeRdp || s.nativeSsh) && !s.recorded;
}

/** When the schedule next rotates it (null: no schedule). */
export function nextScheduled(c: { rotateEveryDays: number | null; rotatedAt: Date | null }, now: Date): Date | null {
  if (c.rotateEveryDays == null) return null;
  const from = c.rotatedAt ?? now;
  const at = new Date(from.getTime() + c.rotateEveryDays * DAY_MS);
  return at < now ? now : at;
}

function sealMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (isSealedValue(s)) out[k] = s;
  return out;
}

type MemberRef = { id: string; name: string };
type KeyedConnector = MemberRef & { status: string; version: string | null; vaultPublicKey: string | null };

export type RotationJob = {
  credentialId: string;
  siteId: string;
  siteName: string;
  op: "apply" | "verify";
  method: RotationMethod;
  target: { host: string; port: number; username: string };
  /** The saved columns the plan was made from; every save is conditional on them. */
  secret: string;
  sealedTo: string;
  seals: Record<string, string>;
  pending: Record<string, string> | null;
  connector: MemberRef;
  connectorKey: string;
  /** Every live key that serves the resource: the prepared password is sealed to all. */
  recipients: string[];
  reconcile: { host: string; port: number; username: string; sealed: string; secretKey: boolean } | null;
  directory: { host: string; port: number; security: string; caCertPem: string; insecureSkipVerify: boolean; baseDN: string; domain: string } | null;
  /** A database account: how the connector connects, as the resource's sessions do. */
  db: { database: string; tls: string; caCertPem: string } | null;
  sshHostKey: string | null;
  failures: number;
  rotatedAt: Date | null;
  rotateEveryDays: number | null;
  verifyOnly: boolean;
};

export type RotationSkip = { siteId: string; siteName: string; reason: string };

const credSelect = {
  id: true, secret: true, sealedTo: true, extraSeals: true, protocol: true, secretKind: true, targetHost: true, targetPort: true, username: true, guacParams: true, dbParams: true,
  rotateAfterSession: true, rotateEveryDays: true, rotateVerifyDaily: true, rotateDueAt: true, rotatedAt: true, verifiedAt: true,
  rotationFailures: true, pendingSeals: true, sshHostKey: true, reconcileUsername: true, reconcileKind: true, reconcileSeals: true,
  site: {
    select: {
      id: true, name: true,
      connector: { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } },
      connectorGroup: { select: { members: { orderBy: { createdAt: "asc" as const }, select: { connector: { select: { id: true, name: true, status: true, version: true, vaultPublicKey: true } } } } } },
    },
  },
} as const;

type CredRow = Prisma.VaultCredentialGetPayload<{ select: typeof credSelect }>;

export async function directoryForRotation(): Promise<DirectoryForRotation | null> {
  const d = await db.directoryConfig.findFirst({ select: { enabled: true, host: true, port: true, security: true, caCertPem: true, insecureSkipVerify: true, baseDN: true, resetUsername: true, resetSeals: true } });
  return d;
}

/** The members (or the one connector) that serve the resource. */
function holders(r: CredRow): KeyedConnector[] {
  const list = r.site.connectorGroup ? r.site.connectorGroup.members.map((m) => m.connector) : [r.site.connector];
  return list.filter((c) => c.status !== "REVOKED");
}

/**
 * One job for one credential: which connector does it, with what. A reason
 * instead when nothing can (it is planned again on the next pass).
 */
export function planJob(r: CredRow, dir: DirectoryForRotation | null, now: Date, opts: { force?: boolean } = {}): RotationJob | RotationSkip | null {
  if (!r.sealedTo) return { siteId: r.site.id, siteName: r.site.name, reason: "The saved password is not sealed to a connector yet." };
  const due = opts.force || (r.rotateDueAt != null && r.rotateDueAt <= now);
  const verifyDue = !due && r.rotateVerifyDaily && (!r.verifiedAt || now.getTime() - r.verifiedAt.getTime() >= DAY_MS);
  if (!due && !verifyDue) return null;
  const m = rotationMethod(r, dir);
  if ("unsupported" in m) return { siteId: r.site.id, siteName: r.site.name, reason: m.unsupported };

  const seals = sealsOf(r);
  const pending = r.pendingSeals ? sealMap(r.pendingSeals) : null;
  const live = holders(r).filter((c) => c.vaultPublicKey);
  const recipients = [...new Set(live.map((c) => c.vaultPublicKey!))];

  const target = { host: r.targetHost, port: r.targetPort, username: r.username };
  // The reconcile account: this server's (Linux, a database), or the directory's (AD).
  let reconcileHost: { host: string; port: number; username: string; seals: Record<string, string>; secretKey: boolean } | null = null;
  if ((m.method === "linux" || isDbMethod(m.method)) && r.reconcileUsername && r.reconcileSeals) {
    reconcileHost = { host: r.targetHost, port: r.targetPort, username: r.reconcileUsername, seals: sealMap(r.reconcileSeals), secretKey: r.reconcileKind === "KEY" };
  } else if (m.method === "ad" && dir?.resetUsername && dir.resetSeals) {
    reconcileHost = { host: dir.host, port: dir.port, username: dir.resetUsername, seals: sealMap(dir.resetSeals), secretKey: false };
  }

  const able = live
    .filter((c) => canRotate(c, m.method) && seals[c.vaultPublicKey!] && (!pending || pending[c.vaultPublicKey!]))
    .sort((a, b) => Number(!!reconcileHost?.seals[b.vaultPublicKey!]) - Number(!!reconcileHost?.seals[a.vaultPublicKey!]) || a.id.localeCompare(b.id));
  const pick = able[0];
  if (!pick) {
    const why = live.some((c) => seals[c.vaultPublicKey!] && c.status === "ONLINE")
      ? `Waiting for a connector on ${rotationMinConnector(m.method)} or later that has the saved password.`
      : "Waiting for a connector that has the saved password to come online.";
    return { siteId: r.site.id, siteName: r.site.name, reason: why };
  }
  const key = pick.vaultPublicKey!;
  const guac = (r.guacParams ?? {}) as Record<string, unknown>;
  const dbp = isDbMethod(m.method) ? parseDbParams(r.dbParams, dbEngineOf(r.protocol)) : null;
  return {
    credentialId: r.id,
    siteId: r.site.id,
    siteName: r.site.name,
    op: due ? "apply" : "verify",
    method: m.method,
    target,
    secret: r.secret,
    sealedTo: r.sealedTo,
    seals,
    pending,
    connector: { id: pick.id, name: pick.name },
    connectorKey: key,
    recipients,
    reconcile: reconcileHost?.seals[key] ? { host: reconcileHost.host, port: reconcileHost.port, username: reconcileHost.username, sealed: reconcileHost.seals[key], secretKey: reconcileHost.secretKey } : null,
    db: dbp ? { database: dbp.database, tls: dbp.tls, caCertPem: dbp.caCertPem ?? "" } : null,
    directory: m.method === "ad" && dir ? { host: dir.host, port: dir.port, security: dir.security, caCertPem: dir.caCertPem, insecureSkipVerify: dir.insecureSkipVerify, baseDN: dir.baseDN, domain: typeof guac.domain === "string" ? guac.domain : "" } : null,
    sshHostKey: r.sshHostKey,
    failures: r.rotationFailures,
    rotatedAt: r.rotatedAt,
    rotateEveryDays: r.rotateEveryDays,
    verifyOnly: !due,
  };
}

/** Phase 1 (scoped). `siteId` + force: "Rotate now" for one resource. */
export async function planRotations(now: Date, opts: { siteId?: string; force?: boolean } = {}): Promise<{ jobs: RotationJob[]; skipped: RotationSkip[] }> {
  const rows = await db.vaultCredential.findMany({
    where: opts.siteId
      ? { siteId: opts.siteId }
      : { sealedTo: { not: null }, OR: [{ rotateDueAt: { lte: now } }, { rotateVerifyDaily: true, OR: [{ verifiedAt: null }, { verifiedAt: { lte: new Date(now.getTime() - DAY_MS) } }] }] },
    select: credSelect,
  });
  if (rows.length === 0) return { jobs: [], skipped: [] };
  const dir = rows.some((r) => r.protocol === "RDP") ? await directoryForRotation() : null;
  const jobs: RotationJob[] = [];
  const skipped: RotationSkip[] = [];
  for (const r of rows) {
    const j = planJob(r, dir, now, { force: opts.force });
    if (!j) continue;
    if ("reason" in j) skipped.push(j);
    else jobs.push(j);
  }
  return { jobs, skipped };
}

// --- the network phase ---

export type ConnectorAnswer = {
  seals?: Record<string, string>;
  outcome?: string;
  reconciled?: boolean;
  outOfSync?: boolean;
  sshHostKey?: string;
  detail?: string;
  error?: string;
};

// Above the dataplane's 27 s stream deadline (and the connector's 24 s), below
// the slow route budget: "Reveal" waits on it inside a request. A change that
// takes longer comes back "unknown" -- both passwords are kept and the next
// attempt asks the target which one it took.
const ROTATE_TIMEOUT_MS = 29_000;

export type RotateCall = (connectorId: string, request: Record<string, unknown>) => Promise<ConnectorAnswer>;

/** The dataplane relays one request to the connector (dataplane/main.go /vault-rotate). */
export const callConnector: RotateCall = async (connectorId, request) => {
  const base = (process.env.DATAPLANE_URL || "http://access-dataplane:3102").replace(/\/+$/, "");
  const res = await fetchWithTimeout(`${base}/vault-rotate`, {
    timeoutMs: ROTATE_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": process.env.DATAPLANE_SECRET ?? "" },
    body: JSON.stringify({ connectorId, request }),
  }).catch(() => null);
  if (!res) return { error: "The data plane did not answer." };
  const data = (await res.json().catch(() => null)) as ConnectorAnswer | null;
  if (!res.ok) return { error: data?.error === "connector offline" ? "The connector is offline." : `The connector did not answer (${data?.error ?? res.status}).` };
  return data ?? { error: "The connector's answer was unreadable." };
};

function baseRequest(j: RotationJob, op: string): Record<string, unknown> {
  return {
    op, method: j.method, host: j.target.host, port: String(j.target.port), username: j.target.username,
    current: j.seals[j.connectorKey], label: j.siteName,
    ...(j.sshHostKey ? { sshHostKey: j.sshHostKey } : {}),
    ...(j.reconcile ? { reconcile: { host: j.reconcile.host, port: String(j.reconcile.port), username: j.reconcile.username, sealed: j.reconcile.sealed, secretKey: j.reconcile.secretKey } } : {}),
    ...(j.db ? { db: { database: j.db.database, tls: j.db.tls, caCertPem: j.db.caCertPem } } : {}),
    ...(j.directory ? { directory: { host: j.directory.host, port: String(j.directory.port), security: j.directory.security, caCertPem: j.directory.caCertPem, insecureSkipVerify: j.directory.insecureSkipVerify, baseDn: j.directory.baseDN, domain: j.directory.domain } } : {}),
  };
}

/** Keeps only seals for the keys asked for, in the sealed format, for all of them. */
export function acceptPrepared(j: RotationJob, seals: Record<string, string> | undefined): Record<string, string> | null {
  if (!seals) return null;
  const out: Record<string, string> = {};
  for (const k of j.recipients) {
    if (!isSealedValue(seals[k])) return null;
    out[k] = seals[k];
  }
  return out;
}

export type RotationResult =
  | { kind: "rotated"; seals: Record<string, string>; reconciled: boolean; outOfSync: boolean; sshHostKey?: string; detail?: string }
  | { kind: "failed"; detail: string; outOfSync: boolean; keepPending: boolean; sshHostKey?: string }
  | { kind: "unknown"; detail: string; sshHostKey?: string }
  | { kind: "verified"; sshHostKey?: string }
  | { kind: "mismatch"; sshHostKey?: string }
  | { kind: "busy" }
  | { kind: "stale" };

export type Scoped = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Phase 2 (unscoped, but saves the prepared seals through `scoped` before the
 * target is touched). `busy` = a session on the resource is open.
 */
export async function runJob(j: RotationJob, scoped: Scoped, deps: { call?: RotateCall; liveSites?: () => Promise<Set<string> | null> } = {}): Promise<RotationResult> {
  const call = deps.call ?? callConnector;
  if (j.verifyOnly) {
    const a = await call(j.connector.id, { ...baseRequest(j, "verify"), ...(j.pending?.[j.connectorKey] ? { pending: j.pending[j.connectorKey] } : {}) });
    if (a.error) return { kind: "failed", detail: a.error, outOfSync: false, keepPending: true };
    if (a.outcome === "ok") return { kind: "verified", sshHostKey: a.sshHostKey };
    if (a.outcome === "pending" && j.pending) return { kind: "rotated", seals: j.pending, reconciled: false, outOfSync: false, sshHostKey: a.sshHostKey };
    return { kind: "mismatch", sshHostKey: a.sshHostKey };
  }

  // Never under a session: the session signed in with the current password.
  const live = await (deps.liveSites ?? liveGatewaySiteIds)();
  if (!live || live.has(j.siteId)) return { kind: "busy" };

  let pending = j.pending;
  if (!pending) {
    const a = await call(j.connector.id, { ...baseRequest(j, "prepare"), to: j.recipients });
    if (a.error) return { kind: "failed", detail: a.error, outOfSync: false, keepPending: false };
    const accepted = acceptPrepared(j, a.seals);
    if (!accepted) return { kind: "failed", detail: "The connector's prepared password was incomplete.", outOfSync: false, keepPending: false };
    const saved = await scoped(() => db.vaultCredential.updateMany({
      where: { id: j.credentialId, secret: j.secret, sealedTo: j.sealedTo, pendingSeals: { equals: Prisma.AnyNull } },
      data: { pendingSeals: accepted as Prisma.InputJsonValue, pendingAt: new Date() },
    })).catch(() => ({ count: 0 }));
    if (saved.count === 0) return { kind: "stale" };
    pending = accepted;
  }

  const a = await call(j.connector.id, { ...baseRequest(j, "apply"), pending: pending[j.connectorKey] });
  // No answer: the target may have taken it. Both stay until the next attempt asks.
  if (a.error) return { kind: "unknown", detail: a.error };
  switch (a.outcome) {
    case "rotated":
    case "already":
      return { kind: "rotated", seals: pending, reconciled: !!a.reconciled, outOfSync: !!a.outOfSync, sshHostKey: a.sshHostKey, detail: a.detail };
    case "failed":
      return { kind: "failed", detail: a.detail || "The target refused the change.", outOfSync: !!a.outOfSync, keepPending: false, sshHostKey: a.sshHostKey };
    default:
      return { kind: "unknown", detail: a.detail || "The connector could not tell whether the target took the new password.", sshHostKey: a.sshHostKey };
  }
}

/** Gateway sessions open now, by resource; null when the data plane does not answer (then nothing rotates). */
export async function liveGatewaySiteIds(): Promise<Set<string> | null> {
  const base = (process.env.DATAPLANE_URL || "http://access-dataplane:3102").replace(/\/+$/, "");
  try {
    const res = await fetchWithTimeout(`${base}/sessions`, { timeoutMs: 5_000, headers: { "x-dataplane-secret": process.env.DATAPLANE_SECRET ?? "" }, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { siteId?: string }[] | null;
    return new Set((Array.isArray(data) ? data : []).map((s) => s.siteId ?? "").filter(Boolean));
  } catch {
    return null;
  }
}

// --- the save phase ---

const SYSTEM: AdminActor = { id: "system", email: null };

/** Phase 3 (scoped): store the outcome, record it, raise what needs a person. */
export async function saveResult(j: RotationJob, r: RotationResult, actor: AdminActor | null, now = new Date()): Promise<void> {
  const who = actor ?? SYSTEM;
  const same = { id: j.credentialId, secret: j.secret, sealedTo: j.sealedTo };
  const hostKey = !j.sshHostKey && "sshHostKey" in r && r.sshHostKey ? { sshHostKey: r.sshHostKey } : {};
  const account = `${j.target.username}@${j.target.host}`;
  switch (r.kind) {
    case "busy":
      return; // still due: the session's close plans it again
    case "stale":
      return; // re-entered meanwhile: the new password stands
    case "verified":
      await db.vaultCredential.updateMany({ where: same, data: { verifiedAt: now, ...hostKey } });
      return;
    case "mismatch": {
      const res = await db.vaultCredential.updateMany({
        where: same,
        // With a reconcile account a rotation resets it now; without one a person has to.
        data: { verifiedAt: now, rotationState: "out_of_sync", rotationDetail: "The saved password no longer signs in.", ...(j.reconcile ? { rotateDueAt: now } : {}), ...hostKey },
      });
      // With a reconcile account the reset that follows says it (rotation-pass.ts), once.
      if (res.count && !j.reconcile) await raise(j, who, "out_of_sync", `The saved password of ${account} no longer signs in on ${j.siteName}: it was changed outside Captivo. Enter it again or add a reconcile account.`);
      return;
    }
    case "rotated": {
      const stored = splitSeals(r.seals, [j.connectorKey, ...j.recipients]);
      const res = await db.vaultCredential.updateMany({
        where: same,
        data: {
          ...storedSecretColumns(stored),
          pendingSeals: Prisma.DbNull, pendingAt: null, rotatedAt: now, verifiedAt: now,
          rotationState: "ok", rotationDetail: r.reconciled ? (j.method === "ad" ? "Set by the directory's password reset account." : "Set by the reconcile account.") : null, rotationFailures: 0,
          rotateDueAt: nextScheduled({ rotateEveryDays: j.rotateEveryDays, rotatedAt: now }, now),
          ...hostKey,
        },
      });
      if (!res.count) return;
      await recordAdminAction({
        actor: who, action: "resource.password_rotate", targetType: "resource", targetId: j.siteId,
        summary: `Rotated the password of ${account} on "${j.siteName}"${r.reconciled ? ` (reset by ${j.reconcile?.username ?? "the reconcile account"})` : ""}`,
        metadata: { connectorId: j.connector.id, method: j.method, reconciled: r.reconciled, outOfSync: r.outOfSync },
      });
      await recordConnectorEvent(j.connector.id, "info", `Rotated the password of ${account} (${j.siteName})`);
      if (r.outOfSync) await raise(j, who, "out_of_sync", `The saved password of ${account} on ${j.siteName} had been changed outside Captivo. The reconcile account reset it.`);
      return;
    }
    case "failed":
    case "unknown": {
      const failures = j.failures + 1;
      const state = r.kind === "unknown" ? "unknown" : r.outOfSync ? "out_of_sync" : "failed";
      const res = await db.vaultCredential.updateMany({
        where: same,
        data: {
          rotationState: state, rotationDetail: r.detail.slice(0, 500), rotationFailures: failures,
          rotateDueAt: new Date(now.getTime() + retryDelayMs(failures)),
          ...(r.kind === "failed" && !r.keepPending ? { pendingSeals: Prisma.DbNull, pendingAt: null } : {}),
          ...hostKey,
        },
      });
      if (!res.count) return;
      await recordAdminAction({
        actor: who, action: "resource.password_rotate_failed", targetType: "resource", targetId: j.siteId,
        summary: `Could not rotate the password of ${account} on "${j.siteName}": ${r.detail}`.slice(0, 500),
        metadata: { connectorId: j.connector.id, method: j.method, state, failures },
      });
      await recordConnectorEvent(j.connector.id, "warn", `Password rotation for ${account} (${j.siteName}): ${r.detail}`);
      // Once per run of failures, not every retry.
      if (failures === 1) await raise(j, who, state === "out_of_sync" ? "out_of_sync" : "rotation_failed", `Password rotation failed on ${j.siteName}: ${r.detail}`);
      return;
    }
  }
}

async function raise(j: RotationJob, _who: AdminActor, type: "rotation_failed" | "out_of_sync", detail: string): Promise<void> {
  try {
    await db.notification.create({ data: { type, siteId: j.siteId, siteName: j.siteName, detail: detail.slice(0, 500) } });
  } catch {
    // Best-effort, like the health notifications.
  }
  try {
    await pushToCapability("read_console", { title: type === "out_of_sync" ? "Password changed outside Captivo" : "Password rotation failed", body: detail.slice(0, 180), data: { type, siteId: j.siteId, origin: await consoleBaseUrl() } });
  } catch {
    // A push never decides anything.
  }
}

