import { db } from "@/lib/db";
import { currentTenantId } from "@/lib/tenant/context";

export interface SessionPolicy {
  idleTimeoutMinutes: number | null;
  maxSessionHours: number | null;
  maxConcurrentPerUser: number | null;
  /** Refuse sign-ins whose `amr` proves no second factor (see lib/auth/amr.ts). */
  requireSecondFactor: boolean;
}

const EMPTY: SessionPolicy = { idleTimeoutMinutes: null, maxSessionHours: null, maxConcurrentPerUser: null, requireSecondFactor: false };

export function sessionTtlMs(policyHours: number | null | undefined, envHours: number): number {
  const h = policyHours && policyHours > 0 ? policyHours : envHours;
  return h * 3600_000;
}
export function idleExpired(lastSeen: Date, now: Date, idleMinutes: number | null | undefined): boolean {
  if (!idleMinutes || idleMinutes <= 0) return false;
  return now.getTime() - lastSeen.getTime() > idleMinutes * 60_000;
}
export function evictionIds(activeOldestFirst: { id: string }[], cap: number | null | undefined): string[] {
  if (!cap || cap <= 0) return [];
  const excess = activeOldestFirst.length - (cap - 1); // leave room for the new session
  if (excess <= 0) return [];
  return activeOldestFirst.slice(0, excess).map((s) => s.id);
}

let cache: { policy: SessionPolicy; at: number } | null = null;

export async function getSessionPolicy(): Promise<SessionPolicy> {
  if (cache && Date.now() - cache.at < 30_000) return cache.policy;
  let c;
  try {
    c = await db.sessionPolicy.findUnique({ where: { tenantId: currentTenantId() } });
  } catch {
    return EMPTY; // table missing / DB down -> no enforcement
  }
  const policy: SessionPolicy = {
    idleTimeoutMinutes: c?.idleTimeoutMinutes ?? null,
    maxSessionHours: c?.maxSessionHours ?? null,
    maxConcurrentPerUser: c?.maxConcurrentPerUser ?? null,
    requireSecondFactor: c?.requireSecondFactor ?? false,
  };
  cache = { policy, at: Date.now() };
  return policy;
}

export async function saveSessionPolicy(input: SessionPolicy): Promise<void> {
  await db.sessionPolicy.upsert({
    where: { tenantId: currentTenantId() },
    create: { tenantId: currentTenantId(), ...input },
    update: { ...input },
  });
  cache = null;
}
