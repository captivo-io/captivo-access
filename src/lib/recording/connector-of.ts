import { db } from "@/lib/db";

/**
 * Which connector holds a recording's bytes.
 *
 * SessionRecording carries only siteId, and the connector lives on Site, so this is
 * the one hop every replay and search path needs. It is its own module because
 * getting it wrong is silent: a null connector makes a recording look empty rather
 * than unreachable, and those are different answers.
 */
export async function connectorForRecording(
  rec: { siteId: string; connectorId?: string | null }
): Promise<string | null> {
  // On a connector group the member that carried the session holds it.
  if (rec.connectorId) return rec.connectorId;
  if (!rec.siteId) return null;
  const site = await db.site.findUnique({
    where: { id: rec.siteId },
    select: { connectorId: true },
  });
  return site?.connectorId ?? null;
}
