import { db } from "@/lib/db";
import { fetchFromConnector } from "@/lib/dataplane/recordings";
import { currentTenantId } from "@/lib/tenant/context";

/**
 * Which connector holds a recording's bytes.
 *
 * Recordings name their connector since 2.46.0; an older one finds it through its
 * resource. It is its own module because getting it wrong is silent: a null
 * connector makes a recording look empty rather than unreachable, and those are
 * different answers.
 *
 * An older recording whose resource was deleted names neither. Given its key and
 * format, the workspace's online connectors are asked which one holds it, and the
 * answer is kept on the recording so the question is asked once.
 */
export async function connectorForRecording(
  rec: { id?: string; siteId: string; connectorId?: string | null; recordingKey?: string; format?: string }
): Promise<string | null> {
  // On a connector group the member that carried the session holds it.
  if (rec.connectorId) return rec.connectorId;
  if (rec.siteId) {
    const site = await db.site.findUnique({
      where: { id: rec.siteId },
      select: { connectorId: true },
    });
    if (site?.connectorId) return site.connectorId;
  }
  if (!rec.id || !rec.recordingKey || !rec.format) return null;
  const found = await findHolder(rec.recordingKey, rec.format);
  if (found) await db.sessionRecording.update({ where: { id: rec.id }, data: { connectorId: found } }).catch(() => undefined);
  return found;
}

/** The streams a recording of this format writes, the main one first. */
export function streamsOf(format: string): ("guac" | "rrweb" | "video" | "keys" | "term" | "rdp")[] {
  switch (format) {
    case "GUAC": return ["guac", "keys"];
    case "RDP": return ["rdp", "video"];
    case "VIDEO": return ["video"];
    case "TERM": return ["term"];
    case "SQL": return ["keys"];
    default: return ["rrweb"];
  }
}

// Asks each online connector for the recording's first byte; the one that has it answers.
async function findHolder(recordingKey: string, format: string): Promise<string | null> {
  const connectors = await db.connector.findMany({ where: { status: "ONLINE" }, select: { id: true } });
  const tenantId = currentTenantId();
  for (const c of connectors) {
    for (const stream of streamsOf(format)) {
      const got = await fetchFromConnector({ connectorId: c.id, tenantId, recordingKey, format: stream, fromByte: 0, toByte: 1 });
      if (got) {
        await got.body.cancel().catch(() => undefined);
        return c.id;
      }
    }
  }
  return null;
}
