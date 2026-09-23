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

/**
 * Whether this installation has a route to the centre at all.
 *
 * This is `service()` itself, not a second copy of its rule: a caller that
 * needs to know BEFORE it starts doing work asks here, and the gate that
 * decides whether a request may go out stays the only one of its kind. Two
 * gates guarding the same thing drift, and the one that drifts is the one
 * left open.
 */
export function isCentreConfigured(env: ServiceEnv = process.env as ServiceEnv): boolean {
  return service(env) !== null;
}

/**
 * The person's Captivo account page, or null when there is no centre.
 *
 * Null on a self-hosted installation and on any deployment that has not been
 * given the centre's address: there is no such page to send anyone to, and a
 * dead link in a menu is worse than a missing one.
 *
 * Derived from the configured issuer rather than written out, so a staging
 * deployment pointing at a staging centre links to the right one.
 */
export function captivoAccountUrl(env: ServiceEnv = process.env as ServiceEnv): string | null {
  const svc = service(env);
  // English path: this console is English-only, and the page answers both.
  return svc ? `${svc.issuer}/account` : null;
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

/**
 * Tell the centre which product this person just entered.
 *
 * So a later sign-in that carries no product intent -- Portal's own login
 * page, the hub -- sends them where they work. ACCESS when they sign in here;
 * PORTAL when they use the switcher to leave, because choosing in the switcher
 * is the same statement as signing in and the destination product cannot see
 * that navigation itself.
 *
 * Best effort and silent: a sign-in must never fail because the centre
 * blinked, and there is nothing the person could do about it if it did.
 */
export async function reportLastProduct(
  email: string,
  product: "ACCESS" | "PORTAL",
  env: ServiceEnv = process.env as ServiceEnv,
): Promise<void> {
  const svc = service(env);
  if (!svc) return;
  try {
    await fetch(`${svc.issuer}/api/last-product`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Captivo-Service": svc.secret },
      body: JSON.stringify({ email, product }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Deliberately swallowed -- see above.
  }
}

/**
 * Everything the centre knows about an organisation: what it is entitled to,
 * and which products it already has a tenant for.
 *
 * Separate from `fetchAccessEntitlement`, which answers one narrower question
 * for the signup flow with a three-state contract. This one is for the product
 * switcher and answers with a picture or nothing.
 *
 * Returns null when the read as a whole fails -- unconfigured, unreachable,
 * refused, or a body that is not the shape we asked for. A body that arrives
 * intact but carries unusable ROWS is not one of those: those rows are dropped
 * and the rest is returned.
 */
export interface CenterEntitlements {
  entitlements: Array<{
    product: string;
    plan: string | null;
    limits: Record<string, number> | null;
    expiresAt: string | null;
  }>;
  links: Array<{ product: string; tenantId: string; consoleOrigin: string | null }>;
}

/**
 * A wire row is only usable if it names its product.
 *
 * `CenterEntitlements` describes what we ASKED for, not what arrived. A body of
 * `{"entitlements":[null]}` satisfies `Array.isArray` and then kills the first
 * consumer that reads `.product` off that null -- and that consumer renders in
 * the console's layout, so one bad row would cost the whole console. This is
 * the boundary where that gets settled, so everything downstream (a pure
 * function shared with the Portal repository, among others) keeps the right to
 * expect clean data.
 */
function isKeyedRow(row: unknown): row is { product: string } {
  return typeof row === "object" && row !== null && typeof (row as { product?: unknown }).product === "string";
}

/**
 * A bridge row whose address is safe to put in an href.
 *
 * `isKeyedRow` finishes only half of "the wire is not the type" for links.
 * `consoleOrigin` is read straight into a menu item's href, so a row like
 * `{product:"PORTAL", consoleOrigin: 42}` passes that filter and renders as
 * `href="42"` -- a relative navigation to a path nobody meant.
 *
 * The row is NOT dropped. That the organisation has a tenant for this product
 * is a real fact, and every consumer already knows what a bridge with a null
 * origin means (fall back to the plain product address). Only the address is
 * unusable, so only the address is reduced.
 */
function withUsableOrigin(row: { product: string }): CenterEntitlements["links"][number] {
  const origin = (row as { consoleOrigin?: unknown }).consoleOrigin;
  return {
    ...(row as CenterEntitlements["links"][number]),
    consoleOrigin: typeof origin === "string" ? origin : null,
  };
}

export async function fetchCenterPicture(
  organizationId: string,
  timeoutMs = TIMEOUT_MS,
  env: ServiceEnv = process.env as ServiceEnv,
): Promise<CenterEntitlements | null> {
  const svc = service(env);
  if (!svc) return null;
  try {
    const res = await fetch(`${svc.issuer}/api/entitlements?org=${encodeURIComponent(organizationId)}`, {
      headers: { "X-Captivo-Service": svc.secret },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<CenterEntitlements>;
    if (!Array.isArray(body.entitlements)) return null;
    return {
      entitlements: body.entitlements.filter(isKeyedRow) as CenterEntitlements["entitlements"],
      links: (Array.isArray(body.links) ? body.links : []).filter(isKeyedRow).map(withUsableOrigin),
    };
  } catch {
    return null;
  }
}
