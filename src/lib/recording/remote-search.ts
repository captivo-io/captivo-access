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

/**
 * `alternates` are connectors holding a copy of the recording (connector groups
 * that keep copies): asked when the original cannot be, so a recording whose
 * original connector is down is still searched.
 */
export type SearchCandidate = { recordingKey: string; connectorId: string | null; alternates?: string[] };

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

  let partial = false;
  const alternatesOf = new Map<string, string[]>();
  // Each recording is asked of its original first; a round per connector, then
  // the recordings of connectors that could not be asked go to a copy, if any.
  let remaining = new Map<string, string[]>();
  const assign = (into: Map<string, string[]>, connectorId: string, key: string) => {
    const list = into.get(connectorId) ?? [];
    list.push(key);
    into.set(connectorId, list);
  };
  for (const c of input.candidates) {
    if (!c.connectorId) {
      // No connector row: its bytes are unreachable, so the answer is incomplete
      // rather than negative. (A copy may still hold them.)
      const [first, ...rest] = c.alternates ?? [];
      if (first) {
        alternatesOf.set(c.recordingKey, rest);
        assign(remaining, first, c.recordingKey);
      } else {
        partial = true;
      }
      continue;
    }
    alternatesOf.set(c.recordingKey, (c.alternates ?? []).filter((a) => a !== c.connectorId));
    assign(remaining, c.connectorId, c.recordingKey);
  }
  if (remaining.size === 0) return { ...empty, partial };

  const matchedKeys: string[] = [];
  const snippets: Record<string, string> = {};
  const unreachableConnectors: string[] = [];
  const failed = new Set<string>();
  let truncated = false;

  while (remaining.size > 0) {
    const round = [...remaining.entries()];
    remaining = new Map();
    const results = await Promise.all(
      round.map(async ([connectorId, recordingKeys]) => ({
        connectorId,
        recordingKeys,
        res: await searchOnConnector({
          connectorId,
          tenantId: input.tenantId,
          query,
          recordingKeys,
          maxDecrypt: COMMAND_SCAN_CAP_PER_CONNECTOR,
        }),
      }))
    );
    for (const { connectorId, recordingKeys, res } of results) {
      if (!res.ok) {
        failed.add(connectorId);
        if (!unreachableConnectors.includes(connectorId)) unreachableConnectors.push(connectorId);
        // These recordings go to a copy that cannot be known to be down; with none left, the answer is partial.
        for (const key of recordingKeys) {
          const alts = (alternatesOf.get(key) ?? []).filter((a) => a !== connectorId && !failed.has(a));
          alternatesOf.set(key, alts.slice(1));
          if (alts[0]) assign(remaining, alts[0], key);
          else partial = true;
        }
        continue;
      }
      if (res.truncated) truncated = true;
      for (const m of res.matches) {
        if (!matchedKeys.includes(m.recordingKey)) matchedKeys.push(m.recordingKey);
        if (!snippets[m.recordingKey]) snippets[m.recordingKey] = m.snippet;
      }
    }
  }

  return { matchedKeys, snippets, truncated, partial, unreachableConnectors };
}
