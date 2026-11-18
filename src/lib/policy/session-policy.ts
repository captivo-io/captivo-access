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

// Per workspace: one shared slot would hand one tenant's policy (idle timeout,
// two-step requirement) to another for up to 30 s on Cloud.
const cache = new Map<string, { policy: SessionPolicy; at: number }>();

export async function getSessionPolicy(): Promise<SessionPolicy> {
  const tid = currentTenantId();
  const hit = cache.get(tid);
  if (hit && Date.now() - hit.at < 30_000) return hit.policy;
  let c;
  try {
    c = await db.sessionPolicy.findUnique({ where: { tenantId: tid } });
  } catch {
    return EMPTY; // table missing / DB down -> no enforcement
  }
  const policy: SessionPolicy = {
    idleTimeoutMinutes: c?.idleTimeoutMinutes ?? null,
    maxSessionHours: c?.maxSessionHours ?? null,
    maxConcurrentPerUser: c?.maxConcurrentPerUser ?? null,
    requireSecondFactor: c?.requireSecondFactor ?? false,
  };
  cache.set(tid, { policy, at: Date.now() });
  return policy;
}

/** Straight from the database: the Policy page shows what is stored now. */
export async function getSessionPolicyFresh(): Promise<SessionPolicy> {
  cache.delete(currentTenantId());
  return getSessionPolicy();
}

export async function saveSessionPolicy(input: SessionPolicy): Promise<void> {
  await db.sessionPolicy.upsert({
    where: { tenantId: currentTenantId() },
    create: { tenantId: currentTenantId(), ...input },
    update: { ...input },
  });
  cache.delete(currentTenantId());
}
