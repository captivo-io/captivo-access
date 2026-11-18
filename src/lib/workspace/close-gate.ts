// Whether this person, in this session, may close the workspace they are in.
// Pure, so the page (which explains) and the route (which enforces) give the
// same answer and the rules can be tested without a database.

/** Where a closed workspace's admins ask for it back. */
export const SUPPORT_ADDRESS = "support@captivo.io";

/** Closing needs a sign-in this recent: an unattended console must not be enough. */
export const FRESH_AUTH_MS = 10 * 60_000;

/** Never closable: the platform operators' own tenant and the self-host one. */
const RESERVED_TENANTS = new Set(["platform", "default"]);

export type CloseRefusal =
  | "not_available" // self-host, or a reserved tenant
  | "forbidden" // not an admin
  | "support_session" // Captivo support acting in the workspace
  | "reauth_required" // the session is older than FRESH_AUTH_MS
  | "confirm_mismatch"; // the typed address is not this workspace's

export interface CloseFacts {
  multiTenant: boolean;
  tenantId: string;
  slug: string | null;
  role: string;
  support: boolean;
  sessionCreatedAt: Date | null;
  now: Date;
}

/** The first rule the request breaks, or null. `confirmSlug` is checked only when given. */
export function closeRefusal(f: CloseFacts, confirmSlug?: unknown): CloseRefusal | null {
  if (!f.multiTenant || RESERVED_TENANTS.has(f.tenantId) || !f.slug) return "not_available";
  if (f.role !== "ADMIN") return "forbidden";
  if (f.support) return "support_session";
  if (!f.sessionCreatedAt || f.now.getTime() - f.sessionCreatedAt.getTime() > FRESH_AUTH_MS) return "reauth_required";
  if (confirmSlug !== undefined && confirmSlug !== f.slug) return "confirm_mismatch";
  return null;
}

/** Until when a workspace closed at `closedAt` can still be restored. */
export function restorableUntil(closedAt: Date, purgeAfterDays: number): Date {
  return new Date(closedAt.getTime() + purgeAfterDays * 86_400_000);
}
