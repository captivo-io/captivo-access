import { searchOnConnector } from "@/lib/dataplane/recordings";

/**
 * Command search across the connectors that hold the text.
 *
 * Keystroke events live in each connector's own store now, so the control plane
 * cannot scan them: it groups the candidate recordings by connector, asks each one
 * to search locally, and merges what comes back. Only matched keys and short
 * snippets travel.
 *
 * The result is deliberately three-valued rather than a plain list:
 *
 *   matchedKeys  what was found
 *   truncated    a connector hit its decrypt budget and stopped looking
 *   partial      at least one connector could not be asked at all
 *
 * `partial` exists because "no matches" and "we could not look" mean opposite
 * things to an administrator investigating an incident, and a silent partial
 * answer is worse than no feature: it reads as proof that nothing happened.
 */
export const COMMAND_SCAN_CAP_PER_CONNECTOR = 50_000;

export type SearchCandidate = { recordingKey: string; connectorId: string | null };

export type FanOutResult = {
  matchedKeys: string[];
  snippets: Record<string, string>;
  truncated: boolean;
  partial: boolean;
  unreachableConnectors: string[];
};

export async function searchRecordingsOnConnectors(input: {
  tenantId: string;
  query: string;
  candidates: SearchCandidate[];
}): Promise<FanOutResult> {
  const empty: FanOutResult = {
    matchedKeys: [],
    snippets: {},
    truncated: false,
    partial: false,
    unreachableConnectors: [],
  };
  const query = input.query.trim();
  // An empty query never matches -- the same rule the central search had, and the
  // reason it exists is that an empty needle would otherwise match everything.
  if (!query || input.candidates.length === 0) return empty;

  const byConnector = new Map<string, string[]>();
  let partial = false;
  for (const c of input.candidates) {
    if (!c.connectorId) {
      // No connector row: its bytes are unreachable, so the answer is incomplete
      // rather than negative.
      partial = true;
      continue;
    }
    const list = byConnector.get(c.connectorId) ?? [];
    list.push(c.recordingKey);
    byConnector.set(c.connectorId, list);
  }
  if (byConnector.size === 0) return { ...empty, partial };

  const results = await Promise.all(
    [...byConnector.entries()].map(async ([connectorId, recordingKeys]) => ({
      connectorId,
      res: await searchOnConnector({
        connectorId,
        tenantId: input.tenantId,
        query,
        recordingKeys,
        maxDecrypt: COMMAND_SCAN_CAP_PER_CONNECTOR,
      }),
    }))
  );

  const matchedKeys: string[] = [];
  const snippets: Record<string, string> = {};
  const unreachableConnectors: string[] = [];
  let truncated = false;

  for (const { connectorId, res } of results) {
    if (!res.ok) {
      unreachableConnectors.push(connectorId);
      partial = true;
      continue;
    }
    if (res.truncated) truncated = true;
    for (const m of res.matches) {
      if (!matchedKeys.includes(m.recordingKey)) matchedKeys.push(m.recordingKey);
      if (!snippets[m.recordingKey]) snippets[m.recordingKey] = m.snippet;
    }
  }

  return { matchedKeys, snippets, truncated, partial, unreachableConnectors };
}
