import { db } from "@/lib/db";
import { agentTokenFrom, hashAgentToken } from "./tokens";

// Who an /api/agent/v1 request is: the token's identity, if the token is live.
// Runs inside the tenant's scope (the route resolves it from the host), so a
// token of another workspace is simply not found.

export type AgentAuth = {
  token: { id: string; name: string; siteIds: string[]; maxMinutes: number; autoApprove: boolean; expiresAt: Date };
  user: { id: string; email: string; name: string };
};

const TOUCH_MS = 60_000;

export async function authenticateAgent(authorization: string | null | undefined, now = new Date()): Promise<AgentAuth | null> {
  const raw = agentTokenFrom(authorization);
  if (!raw) return null;
  const t = await db.apiToken.findFirst({
    where: { tokenHash: hashAgentToken(raw), revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, name: true, siteIds: true, maxMinutes: true, autoApprove: true, expiresAt: true, lastUsedAt: true, user: { select: { id: true, email: true, name: true, status: true } } },
  });
  if (!t || t.user.status !== "ACTIVE") return null;
  if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > TOUCH_MS) {
    await db.apiToken.update({ where: { id: t.id }, data: { lastUsedAt: now } }).catch(() => undefined);
  }
  return { token: { id: t.id, name: t.name, siteIds: t.siteIds, maxMinutes: t.maxMinutes, autoApprove: t.autoApprove, expiresAt: t.expiresAt }, user: { id: t.user.id, email: t.user.email, name: t.user.name } };
}
