// Pure rules for the Resources page's bulk actions (api/admin/sites/bulk).

export type BulkAction = "delete" | "move";
export const BULK_MAX = 500;

export type BulkInput = { ids: string[]; action: BulkAction; connectorId?: string };

/** Validates the request body; ids are de-duplicated and capped. */
export function parseBulk(body: unknown): BulkInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.action !== "delete" && b.action !== "move") return { error: "invalid_action" };
  if (!Array.isArray(b.ids) || b.ids.length === 0 || !b.ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) return { error: "invalid_ids" };
  const ids = [...new Set(b.ids as string[])];
  if (ids.length > BULK_MAX) return { error: "too_many" };
  if (b.action === "move") {
    if (typeof b.connectorId !== "string" || !b.connectorId) return { error: "connector_required" };
    return { ids, action: "move", connectorId: b.connectorId };
  }
  return { ids, action: "delete" };
}

export type MovableSite = { id: string; accessMode: string; connectorId: string; sealed: boolean };

/**
 * Which resources a move can take. A remote-desktop password sealed to its
 * connector opens only there (lib/vault/store.ts keptSecretStillOpens), so
 * those stay and must be moved one by one with the password typed again.
 * Resources already on the target are left as they are.
 */
export function planMove(sites: MovableSite[], target: string): { move: string[]; sealed: string[]; already: string[] } {
  const move: string[] = [], sealed: string[] = [], already: string[] = [];
  for (const s of sites) {
    if (s.connectorId === target) already.push(s.id);
    else if (s.accessMode === "GATEWAY" && s.sealed) sealed.push(s.id);
    else move.push(s.id);
  }
  return { move, sealed, already };
}
