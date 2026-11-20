import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { multiTenantEnabled } from "@/lib/tenant/enabled";
import { parseDestination, secretRequired, type DestinationData } from "./config";

// Shared by the create and update routes: the form's body to the row's data.

export type SaveResult = { ok: true; data: DestinationData & { secret?: string | null } } | { ok: false; error: string; status: number };

/**
 * `existing` is the stored row on an update. Its secret is kept when the form
 * leaves the field blank and the kind is unchanged: a Splunk token must not
 * become a Datadog key because someone switched the kind.
 */
export async function destinationFromBody(
  body: Record<string, unknown>,
  existing: { kind: string; secret: string | null } | null,
): Promise<SaveResult> {
  const parsed = parseDestination(body, { cloud: multiTenantEnabled() });
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  const { data, secret } = parsed;
  if (data.kind === "syslog") {
    const ids = [data.connectorId, data.fallbackConnectorId].filter((x): x is string => !!x);
    const found = await db.connector.count({ where: { id: { in: ids }, status: { not: "REVOKED" } } });
    if (found !== ids.length) return { ok: false, error: "unknown_connector", status: 400 };
    return { ok: true, data: { ...data, secret: null } };
  }
  const kept = existing && existing.kind === data.kind ? existing.secret : null;
  const enc = secret ? encrypt(secret) : kept;
  if (!enc && secretRequired(data)) return { ok: false, error: "secret_required", status: 400 };
  return { ok: true, data: { ...data, secret: data.kind === "https" && !data.headerName ? null : enc } };
}
