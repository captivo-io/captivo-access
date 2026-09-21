// Thin typed wrappers over the platform SECURITY DEFINER functions (see
// prisma/rls/bootstrap.sql §6/§8). Called from the platform tenant's request
// scope; the functions do the RLS bypass, requirePlatformAdmin does authorization.
// Function names are fixed literals; every value is a bound parameter.
import { base } from "@/lib/db";

export interface TenantStatsRow {
  id: string; users: bigint; admins: bigint; vendors: bigint; sites: bigint; connectors: bigint; connectorsOnline: bigint;
  grantsActive: bigint; requestsPending: bigint; auditEvents: bigint; recordings: bigint; recordingBytes: unknown; sessions24h: bigint;
  lastActivity: Date | null;
}
export interface TenantStats {
  id: string; users: number; admins: number; vendors: number; sites: number; connectors: number; connectorsOnline: number;
  grantsActive: number; requestsPending: number; auditEvents: number; recordings: number; recordingBytes: number; sessions24h: number;
  lastActivity: Date | null;
}
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0) || 0);

export async function tenantStats(): Promise<Map<string, TenantStats>> {
  const rows = await base.$queryRawUnsafe<TenantStatsRow[]>(`SELECT * FROM platform_tenant_stats()`);
  const m = new Map<string, TenantStats>();
  for (const r of rows) {
    m.set(r.id, {
      id: r.id, users: num(r.users), admins: num(r.admins), vendors: num(r.vendors), sites: num(r.sites), connectors: num(r.connectors),
      connectorsOnline: num(r.connectorsOnline), grantsActive: num(r.grantsActive), requestsPending: num(r.requestsPending),
      auditEvents: num(r.auditEvents), recordings: num(r.recordings), recordingBytes: num(r.recordingBytes), sessions24h: num(r.sessions24h),
      lastActivity: r.lastActivity ? new Date(r.lastActivity) : null,
    });
  }
  return m;
}

export interface FoundUser { tenantId: string; slug: string; tenantName: string; id: string; email: string; name: string; role: string; status: string; createdAt: Date }
export async function findUsers(email: string): Promise<FoundUser[]> {
  const q = email.trim();
  if (q.length < 2) return [];
  return base.$queryRawUnsafe<FoundUser[]>(`SELECT * FROM platform_find_users($1)`, q);
}

export interface AdminEventRow { tenantId: string; slug: string; id: string; timestamp: Date; actorEmail: string | null; action: string; targetType: string | null; targetId: string | null; summary: string }
export async function recentAdminEvents(limit: number, tenantId: string | null): Promise<AdminEventRow[]> {
  return base.$queryRawUnsafe<AdminEventRow[]>(`SELECT * FROM platform_recent_admin_events($1::int, $2)`, limit, tenantId);
}

export interface AccessEventRow { tenantId: string; slug: string; id: string; timestamp: Date; userEmail: string | null; siteName: string | null; host: string; decision: string; reason: string | null }
export async function recentAccessEvents(limit: number, tenantId: string | null): Promise<AccessEventRow[]> {
  return base.$queryRawUnsafe<AccessEventRow[]>(`SELECT * FROM platform_recent_access_events($1::int, $2)`, limit, tenantId);
}

export interface CronRunRow { tenantId: string; slug: string; job: string; ranAt: Date }
export async function cronRuns(): Promise<CronRunRow[]> {
  return base.$queryRawUnsafe<CronRunRow[]>(`SELECT * FROM platform_cron_runs()`);
}

export async function updateTenantRow(input: { id: string; name: string; plan: string; trialEndsAt: Date | null; limits: unknown | null; capabilities: unknown | null; notes: string | null }): Promise<void> {
  // void-returning functions must go through $executeRawUnsafe (Prisma 7 can't
  // deserialize a void column from $queryRawUnsafe).
  await base.$executeRawUnsafe(
    `SELECT platform_update_tenant($1, $2, $3, $4::timestamptz, $5::jsonb, $6::jsonb, $7)`,
    input.id, input.name, input.plan, input.trialEndsAt, input.limits === null ? null : JSON.stringify(input.limits), input.capabilities === null ? null : JSON.stringify(input.capabilities), input.notes,
  );
}
/**
 * The slug of the workspace already provisioned for a Captivo ID organisation,
 * or null when that organisation has none.
 *
 * Owner-defined function rather than a Prisma query: the caller is scoped to
 * the platform tenant, and the RLS policy on "Tenant" would hide every other
 * tenant's row from it.
 */
export async function tenantSlugByOrg(organizationId: string): Promise<string | null> {
  const rows = await base.$queryRawUnsafe<{ platform_tenant_slug_by_org: string | null }[]>(
    `SELECT platform_tenant_slug_by_org($1)`,
    organizationId,
  );
  return rows[0]?.platform_tenant_slug_by_org ?? null;
}

export async function softDeleteTenantRow(id: string): Promise<void> { await base.$executeRawUnsafe(`SELECT platform_delete_tenant($1)`, id); }
export async function restoreTenantRow(id: string): Promise<void> { await base.$executeRawUnsafe(`SELECT platform_restore_tenant($1)`, id); }
export async function purgeTenantRow(id: string): Promise<void> { await base.$executeRawUnsafe(`SELECT platform_purge_tenant($1)`, id); }
export async function purgeCandidates(days: number): Promise<string[]> {
  const rows = await base.$queryRawUnsafe<{ platform_purge_candidates: string }[]>(`SELECT platform_purge_candidates($1::int)`, days);
  return rows.map((r) => r.platform_purge_candidates);
}
export async function expiredTrials(): Promise<string[]> {
  const rows = await base.$queryRawUnsafe<{ platform_expired_trials: string }[]>(`SELECT platform_expired_trials()`);
  return rows.map((r) => r.platform_expired_trials);
}
export interface PlatformSmtpRow { host: string; port: number; secure: boolean; username: string; password: string; fromName: string; fromEmail: string }
export async function platformSmtpConfig(): Promise<PlatformSmtpRow | null> {
  const rows = await base.$queryRawUnsafe<PlatformSmtpRow[]>(`SELECT * FROM platform_smtp_config()`);
  return rows[0] ?? null;
}
