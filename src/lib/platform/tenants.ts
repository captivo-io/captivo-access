import { base } from "@/lib/db";
import { withTenant } from "@/lib/tenant/scope";
import { createInvite } from "@/lib/auth/invite";
import { isValidTenantSlug } from "@/lib/tenant/constants";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { isPlan, parseLimits, parseCapabilities, type Plan, type TenantLimits, type TenantCapabilities } from "@/lib/platform/tenant-shape";
import { updateTenantRow, softDeleteTenantRow, restoreTenantRow, purgeTenantRow } from "@/lib/platform/sql";
import { savePlatformSettings, getPlatformSettings } from "@/lib/settings/platform";
import { getPlatformConfig, newTenantDefaultsFrom } from "@/lib/platform/config";

export class PlatformError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "PlatformError";
  }
}

export interface PlatformTenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt: Date;
  adminCount: number;
  plan: Plan;
  trialEndsAt: Date | null;
  deletedAt: Date | null;
  limits: TenantLimits;
  capabilities: TenantCapabilities;
  notes: string | null;
  updatedAt: Date;
}

// Minimal email sanity check (the invite is the real proof of address).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCreateInput(input: { name: string; slug: string; adminEmail: string; adminName?: string }) {
  if (!input.name.trim()) throw new PlatformError("invalid_name");
  if (!isValidTenantSlug(input.slug)) throw new PlatformError("invalid_slug");
  if (!EMAIL_RE.test(input.adminEmail.trim())) throw new PlatformError("invalid_email");
}

// Confirmed empirically against Prisma 7.9 + the pg driver adapter: a Postgres
// unique-violation (SQLSTATE 23505) raised inside a raw query surfaces as a
// PrismaClientKnownRequestError with code "P2010" (generic "raw query failed"),
// and the actual SQLSTATE is nested at meta.driverAdapterError.cause.originalCode
// (meta.code is NOT the SQLSTATE on this client — don't rely on it). Any other
// error (connection failure, pool exhaustion, permission/grant regression,
// etc.) must propagate unchanged so it isn't misreported as "slug taken".
function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } };
  };
  return err.code === "P2010" && err.meta?.driverAdapterError?.cause?.originalCode === "23505";
}

type TenantRow = {
  id: string; slug: string; name: string; status: string; createdAt: Date; adminCount: bigint;
  plan: string; trialEndsAt: Date | null; deletedAt: Date | null; limits: unknown; capabilities: unknown; notes: string | null; updatedAt: Date;
};
function shape(r: TenantRow): PlatformTenant {
  return {
    id: r.id, slug: r.slug, name: r.name, status: r.status, createdAt: new Date(r.createdAt), adminCount: Number(r.adminCount),
    plan: isPlan(r.plan) ? r.plan : "standard",
    trialEndsAt: r.trialEndsAt ? new Date(r.trialEndsAt) : null,
    deletedAt: r.deletedAt ? new Date(r.deletedAt) : null,
    limits: parseLimits(r.limits), capabilities: parseCapabilities(r.capabilities),
    notes: r.notes, updatedAt: new Date(r.updatedAt),
  };
}

// All tenants (including soft-deleted — the console shows them under "Deleted").
export async function listTenants(): Promise<PlatformTenant[]> {
  const rows = await base.$queryRawUnsafe<TenantRow[]>(`SELECT * FROM platform_list_tenants()`);
  return rows.map(shape);
}

export async function getTenant(id: string): Promise<PlatformTenant | null> {
  return (await listTenants()).find((t) => t.id === id) ?? null;
}

export interface UpdateTenantInput { name: string; plan: string; trialEndsAt: Date | null; limits: unknown; capabilities: unknown; notes: string | null }
export function validateUpdateInput(input: UpdateTenantInput): { name: string; plan: Plan; trialEndsAt: Date | null; limits: TenantLimits; capabilities: TenantCapabilities; notes: string | null } {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new PlatformError("invalid_name");
  if (!isPlan(input.plan)) throw new PlatformError("invalid_plan");
  if (input.trialEndsAt && Number.isNaN(input.trialEndsAt.getTime())) throw new PlatformError("invalid_trial_end");
  const notes = input.notes?.trim() ? input.notes.trim().slice(0, 4000) : null;
  return { name, plan: input.plan, trialEndsAt: input.plan === "trial" ? input.trialEndsAt : null, limits: parseLimits(input.limits), capabilities: parseCapabilities(input.capabilities), notes };
}

export async function updateTenant(id: string, input: UpdateTenantInput): Promise<void> {
  const v = validateUpdateInput(input);
  await updateTenantRow({
    id, name: v.name, plan: v.plan, trialEndsAt: v.trialEndsAt,
    limits: Object.keys(v.limits).length ? v.limits : null,
    capabilities: Object.keys(v.capabilities).length ? v.capabilities : null,
    notes: v.notes,
  });
}

// Soft delete: hidden from resolvers + fan-out, sessions dropped, restorable
// until the platform-ops cron purges it after PURGE_AFTER_DAYS.
export const PURGE_AFTER_DAYS = 30;
export async function deleteTenant(id: string): Promise<void> { await softDeleteTenantRow(id); }
export async function restoreTenant(id: string): Promise<void> { await restoreTenantRow(id); }
export async function purgeTenant(id: string): Promise<void> { await purgeTenantRow(id); }

export async function setTenantStatus(id: string, status: "ACTIVE" | "SUSPENDED"): Promise<void> {
  // The SQL function returns void; $queryRawUnsafe can't deserialize a void
  // column (Prisma 7), so this must be $executeRawUnsafe.
  await base.$executeRawUnsafe(`SELECT platform_set_tenant_status($1, $2)`, id, status);
}

export async function createTenant(input: { name: string; slug: string; adminEmail: string; adminName?: string; plan?: string; trialDays?: number; limits?: TenantLimits; captivoOrgId?: string }) {
  validateCreateInput(input);
  const id = crypto.randomUUID();
  const name = input.name.trim();
  const slug = input.slug;

  // 1. Create the Tenant row via the RLS-bypass function (unscoped, as owner-defined).
  // captivoOrgId goes in with the INSERT rather than in a follow-up UPDATE, so
  // the unique index refuses a second workspace for the same Captivo ID
  // organisation before any invite or settings row exists to clean up.
  try {
    await base.$queryRawUnsafe(`SELECT platform_create_tenant($1, $2, $3, $4::text)`, id, slug, name, input.captivoOrgId ?? null);
  } catch (e) {
    // A genuine unique-violation on slug/id → a friendly conflict. Everything
    // else (DB outage, pool exhaustion, a grant regression, ...) propagates
    // unchanged — it must never be masked as "slug taken".
    // Two unique columns can raise 23505 here: the slug the person chose and
    // the Captivo ID organisation (the race backstop behind the caller's own
    // "already provisioned" check). Telling someone the slug is taken when it
    // is not would send them renaming their console forever, so the constraint
    // is read off the driver's message when it is there; when it is not, this
    // falls back to the slug reading, which is what it always did.
    if (isUniqueViolation(e)) {
      const message = (e as Error).message;
      if (input.captivoOrgId && /captivoOrgId/i.test(message)) throw new PlatformError("org_taken", message);
      throw new PlatformError("slug_taken", message);
    }
    throw e;
  }

  // 2. Provision the first admin: an invite IN THE NEW TENANT, via the existing
  // invite machinery under the new tenant's scope (the insert trigger stamps
  // tenantId; RLS WITH CHECK passes). createdById is null (system-provisioned).
  const { token } = await withTenant(id, () =>
    // The admin's name when the operator knows it; otherwise the email stands in
    // and the invitee is asked for their name at enrollment.
    createInvite({ email: input.adminEmail, name: input.adminName?.trim() || input.adminEmail, role: "ADMIN", createdById: null }),
  );

  // 3. Plan / trial + the platform's defaults for new tenants (Settings →
  // New tenant defaults), written as the tenant's own PlatformSettings row.
  const plan = isPlan(input.plan) ? input.plan : "standard";
  const limits = input.limits ?? null;
  // Written whenever the plan is not the default OR caps were supplied: a
  // standard tenant with caps used to fall through this branch and lose them.
  if (plan !== "standard" || limits) {
    const trialEndsAt = plan === "trial" ? new Date(Date.now() + (input.trialDays ?? 14) * 24 * 3600 * 1000) : null;
    await updateTenantRow({ id, name, plan, trialEndsAt, limits, capabilities: null, notes: null });
  }
  const defaults = newTenantDefaultsFrom(await getPlatformConfig());
  if (defaults) {
    await withTenant(id, async () => {
      const current = await getPlatformSettings();
      await savePlatformSettings({ ...current, ...defaults });
    });
  }

  // The first admin accepts the invite at the tenant's own console host,
  // <slug>.<consoleDomain>. Prefer CONSOLE_DOMAIN; fall back to the access domain.
  const domain = consoleDomain() ?? "";
  const inviteUrl = domain
    ? `https://${slug}.${domain}/invite/${token}`
    : `/invite/${token}`;

  return { tenant: { id, slug, name }, inviteToken: token, inviteUrl };
}
