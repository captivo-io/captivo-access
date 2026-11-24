import { db } from "@/lib/db";
import { evaluateAccess } from "@/lib/access/evaluate";
import { classifyGrant } from "@/lib/access/classify";
import { getVaultCredential } from "@/lib/vault/store";
import { effectiveSiteRecording } from "@/lib/recording/effective";
import { candidatesFor, newestVersion, routeMembers, siteRoutingSelect, type RouteCandidate } from "@/lib/connector/route";
import { databaseBlock, dbEngineOf, dbEngineWire, dbMinConnector, parseDbParams, type DbBlock, type DbParams } from "@/lib/database/params";

export type DatabaseTarget =
  | {
      ok: true; siteName: string; engine: ReturnType<typeof dbEngineWire>; targetHost: string; targetPort: number; username: string;
      params: DbParams; connectors: RouteCandidate[]; record: boolean;
    }
  | { ok: false; status: number; error: "not_found" | "forbidden" | "vault_secret_reenter" | DbBlock; reason?: string };

/**
 * Whether this user may open this database resource now, and how: its server,
 * the account the connector signs in with, and each connector that may carry
 * the connection with the password sealed to its own key. The portal's ticket
 * and the proxy's check at every connection both ask this. Runs inside the
 * resource's tenant scope.
 */
export async function databaseTarget(userId: string, siteId: string, now: Date): Promise<DatabaseTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { name: true, accessMode: true, recordSessions: true, ...siteRoutingSelect, vaultCredential: { select: { dbParams: true, protocol: true } } },
  });
  if (!site) return { ok: false, status: 404, error: "not_found" };
  const decision = await evaluateAccess(userId, siteId, now);
  if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
  const engine = dbEngineOf(site.vaultCredential?.protocol);
  const block = databaseBlock({ accessMode: site.accessMode, connectorVersion: newestVersion(site), engine });
  if (block) return { ok: false, status: 409, error: block };
  const cred = await getVaultCredential(siteId);
  if (!cred || !cred.sealedSecret || cred.stale) return { ok: false, status: 409, error: "vault_secret_reenter" };
  const members = routeMembers(site, { minVersion: dbMinConnector(engine), canOpen: (m) => !!m.vaultPublicKey && !!cred.seals[m.vaultPublicKey] }).eligible;
  if (members.length === 0) return { ok: false, status: 409, error: "connector_outdated" };
  return {
    ok: true,
    siteName: site.name,
    engine: dbEngineWire(engine),
    targetHost: cred.targetHost,
    targetPort: cred.targetPort,
    username: cred.username,
    params: parseDbParams(site.vaultCredential?.dbParams, engine),
    connectors: candidatesFor(members, (m) => ({ sealedSecret: (m.vaultPublicKey && cred.seals[m.vaultPublicKey]) || cred.sealedSecret })),
    record: await effectiveSiteRecording(site.recordSessions),
  };
}

/** The latest end among the grants that allow access now; null when one has no end. */
export async function grantEnd(userId: string, siteId: string, now: Date): Promise<Date | null> {
  const grants = await db.accessGrant.findMany({ where: { userId, siteId } });
  let end: Date | null | undefined;
  for (const g of grants) {
    if (classifyGrant(g, now) !== "allow") continue;
    if (!g.endsAt) return null;
    if (end === undefined || (end && g.endsAt > end)) end = g.endsAt;
  }
  return end ?? null;
}
