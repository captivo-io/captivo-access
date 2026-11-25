import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/auth/tokens";

// Database and Kubernetes tickets hang off a session (they end with it). An
// agent has no console session, so it gets one that nobody holds the key to:
// its token hash is of random bytes thrown away, so it can never be a cookie,
// and it only carries tickets. One is reused while it has hours left.

const SESSION_HOURS = 8;
const MARK = "agent-api";

export async function agentSession(userId: string, now = new Date()): Promise<{ id: string; expiresAt: Date }> {
  await db.session.deleteMany({ where: { userId, userAgent: MARK, expiresAt: { lt: now } } });
  const live = await db.session.findFirst({ where: { userId, userAgent: MARK, expiresAt: { gt: new Date(now.getTime() + 3600_000) } }, select: { id: true, expiresAt: true } });
  if (live) return live;
  return db.session.create({
    data: { userId, tokenHash: sha256(randomBytes(32).toString("hex")), expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000), userAgent: MARK, mobile: true },
    select: { id: true, expiresAt: true },
  });
}
