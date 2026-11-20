import { fetchWithTimeout } from "@/lib/net/fetch-timeout";

/** The data-plane waits up to 10 s for the connector's answer. */
const HOST_ACTION_TIMEOUT_MS = 15_000;

/** Asks the data-plane to hand an action to the connector; resolves once the connector answered. */
export async function sendHostAction(
  connectorId: string,
  a: { id: string; action: "update" | "uninstall" | "cancel"; version?: string; keepData?: boolean; waitIdle?: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  const base = process.env.DATAPLANE_URL || "http://access-dataplane:3102";
  const secret = process.env.DATAPLANE_SECRET || "";
  const res = await fetchWithTimeout(`${base}/connector-hostaction`, {
    timeoutMs: HOST_ACTION_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", "x-dataplane-secret": secret },
    body: JSON.stringify({ connectorId, ...a }),
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, reason: "no_answer" };
  return (await res.json().catch(() => ({ ok: false, reason: "no_answer" }))) as { ok: boolean; reason?: string };
}
