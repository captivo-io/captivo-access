import { fetchWithTimeout } from "@/lib/net/fetch-timeout";

/** Pushes a policy down a connector tunnel; the connector acknowledges from memory. */
const POLICY_PUSH_TIMEOUT_MS = 10_000;

import { db } from "@/lib/db";
import { resolvedConnectorLogLevel, resolvedRecordingRetentionDays } from "@/lib/settings/platform";
import { currentTenantId } from "@/lib/tenant/context";
import { pendingErasuresByConnector } from "@/lib/recording/erasure";

// Pushes a connector's full policy (egress narrowing + log level) to its live
// control stream via the data-plane. Reads the current saved values from the DB
// so a caller that changed only one field never clobbers the other. Fail-soft —
// an offline/unreachable connector is not an error; the policy is applied on the
// connector's next connect (via the status response).
export async function pushConnectorPolicy(
  connectorId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const c = await db.connector.findUnique({
    where: { id: connectorId },
    select: { egressPolicy: true, logLevel: true },
  });
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const secret = process.env.DATAPLANE_SECRET || "";
  const res = await fetchWithTimeout(`${base}/connector-policy`, { timeoutMs: POLICY_PUSH_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": secret },
    body: JSON.stringify({
      connectorId,
      egressAllowedTargets: c?.egressPolicy ?? "",
      logLevel: await resolvedConnectorLogLevel(c?.logLevel ?? null),
      // The recording half. The connector owns its files, so retention and erasure
      // travel with the policy rather than as commands of their own: whenever a
      // connector is reachable it learns the current window and what it still owes.
      tenantId: currentTenantId(),
      recordingRetentionDays: await resolvedRecordingRetentionDays(),
      purgeRecordingKeys: (await pendingErasuresByConnector()).get(connectorId) ?? [],
    }),
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, reason: "unreachable" };
  return res.json();
}
