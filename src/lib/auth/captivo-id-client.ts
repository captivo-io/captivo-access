/**
 * Service-to-service calls to Captivo ID.
 *
 * Separate from captivo-id-register.ts because these two run at a different
 * moment and with a different failure policy: registration is fire-and-forget
 * after the user already has what they came for, whereas these decide whether a
 * workspace may be created at all.
 *
 * Both fail CLOSED and never throw. A caller must be able to say "the centre
 * did not answer" without a stack trace reaching the person signing in.
 */

const TIMEOUT_MS = 5_000;

interface ServiceEnv {
  CAPTIVO_ID_ISSUER?: string;
  CAPTIVO_ID_SERVICE_SECRET?: string;
}

function service(env: ServiceEnv): { issuer: string; secret: string } | null {
  const issuer = env.CAPTIVO_ID_ISSUER?.trim().replace(/\/+$/, "");
  const secret = env.CAPTIVO_ID_SERVICE_SECRET?.trim();
  if (!issuer || !secret) return null;
  return { issuer, secret };
}

/** What the centre said about an organisation's ACCESS entitlement. */
export interface AccessEntitlement {
  plan: string | null;
  limits: Record<string, number> | null;
  /** ISO 8601, or null when the entitlement does not lapse. */
  expiresAt: string | null;
}

/**
 * The outcome of asking the centre, as three cases rather than one nullable
 * answer.
 *
 * "The centre says this organisation has no ACCESS entitlement" and "the centre
 * did not answer" are opposite facts: the first is a decision the caller may
 * act on, the second is an absence of one. Collapsing them into null told
 * someone who had just presented a valid grant that their organisation was not
 * entitled -- wrong, and nothing they could act on.
 */
export type EntitlementLookup =
  | ({ status: "ok" } & AccessEntitlement)
  | { status: "none" }
  | { status: "unavailable"; reason: "not_configured" | "unreachable" | "bad_response" };

/** Ask the centre for the organisation's ACCESS tier, caps and expiry. */
export async function fetchAccessEntitlement(
  organizationId: string,
  env: ServiceEnv = process.env as ServiceEnv,
): Promise<EntitlementLookup> {
  const svc = service(env);
  if (!svc) return { status: "unavailable", reason: "not_configured" };
  try {
    const res = await fetch(`${svc.issuer}/api/entitlements?org=${encodeURIComponent(organizationId)}`, {
      headers: { "X-Captivo-Service": svc.secret },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A non-2xx is the centre failing to answer, not the centre saying "no":
    // a 500 or a 401 from a rotated secret says nothing about the entitlement.
    if (!res.ok) return { status: "unavailable", reason: "bad_response" };
    const body = (await res.json()) as { entitlements?: Array<Record<string, unknown>> };
    const row = (body.entitlements ?? []).find((e) => e.product === "ACCESS");
    if (!row) return { status: "none" };
    return {
      status: "ok",
      plan: typeof row.plan === "string" ? row.plan : null,
      limits: row.limits && typeof row.limits === "object" ? (row.limits as Record<string, number>) : null,
      expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    };
  } catch {
    return { status: "unavailable", reason: "unreachable" };
  }
}

/**
 * Tell the centre where this tenant lives, so its console host becomes a valid
 * OIDC redirect target. Returns false when the centre did not accept it -- the
 * workspace exists either way, but nobody can sign in to it until this
 * succeeds, so the caller has to be able to say so.
 */
export async function reportTenantLink(
  input: { organizationId: string; tenantId: string; consoleOrigin: string },
  env: ServiceEnv = process.env as ServiceEnv,
): Promise<boolean> {
  const svc = service(env);
  if (!svc) return false;
  try {
    const res = await fetch(`${svc.issuer}/api/tenant-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Captivo-Service": svc.secret },
      body: JSON.stringify({ ...input, product: "ACCESS" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
