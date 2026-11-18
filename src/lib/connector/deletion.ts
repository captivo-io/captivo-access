export type ConnectorDeleteCheck = { ok: true } | { ok: false; reason: "not_revoked" | "has_sites" | "confirm_mismatch" };

// A connector can be hard-deleted only when it's REVOKED and has no sites — the
// Site.connectorId FK is onDelete:Cascade, so deleting a connector with sites
// would silently remove those sites and their access grants. "Delete with its
// resources" asks for exactly that, so it needs the connector's name typed back.
export function canDeleteConnector(input: { status: string; siteCount: number; withSites?: { name: string; confirmName: unknown } }): ConnectorDeleteCheck {
  if (input.status !== "REVOKED") return { ok: false, reason: "not_revoked" };
  if (input.withSites) {
    if (typeof input.withSites.confirmName !== "string" || input.withSites.confirmName.trim() !== input.withSites.name.trim()) return { ok: false, reason: "confirm_mismatch" };
    return { ok: true };
  }
  if (input.siteCount > 0) return { ok: false, reason: "has_sites" };
  return { ok: true };
}
