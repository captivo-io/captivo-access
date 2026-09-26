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
  siteId: string
): Promise<string | null> {
  if (!siteId) return null;
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { connectorId: true },
  });
  return site?.connectorId ?? null;
}
