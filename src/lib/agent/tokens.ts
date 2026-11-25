import { generateToken, sha256 } from "@/lib/auth/tokens";

// Agent tokens (model ApiToken): what a machine or an AI agent signs in to
// /api/agent/v1 with. The token is 32 random bytes, so a plain SHA-256 is
// enough to look it up, as for console sessions.

export const AGENT_TOKEN_PREFIX = "cat_";
export const AGENT_DEFAULT_DAYS = 30;
export const AGENT_MAX_DAYS = 90;
export const AGENT_MIN_MINUTES = 5;
export const AGENT_MAX_MINUTES = 24 * 60;
export const AGENT_DEFAULT_MINUTES = 60;
export const AGENT_MAX_SITES = 50;
export const AGENT_MIN_REASON = 10;
export const AGENT_DEFAULT_RATE = 120;
export const AGENT_MIN_RATE = 10;
export const AGENT_MAX_RATE = 600;

export function newAgentToken(): { token: string; hash: string; prefix: string } {
  const token = AGENT_TOKEN_PREFIX + generateToken();
  return { token, hash: sha256(token), prefix: token.slice(0, AGENT_TOKEN_PREFIX.length + 6) };
}

/** The bearer token of a request, when it looks like an agent token. */
export function agentTokenFrom(authorization: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return m && m[1].startsWith(AGENT_TOKEN_PREFIX) && m[1].length <= 200 ? m[1] : null;
}

export const hashAgentToken = sha256;

/** The email of an agent's identity: it cannot receive mail and nobody can claim it. */
export function agentIdentityEmail(id: string): string {
  return `agent-${id}@agents.invalid`;
}

export type AgentTokenInput = { name: string; siteIds: string[]; maxMinutes: number; autoApprove: boolean; days: number; ratePerMinute: number };

/** Reads an admin's request to make a token. */
export function parseAgentTokenInput(b: Record<string, unknown>): AgentTokenInput | { error: string } {
  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 60) return { error: "invalid_name" };
  const ids = Array.isArray(b.siteIds) ? [...new Set(b.siteIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64))] : [];
  if (ids.length === 0) return { error: "sites_required" };
  if (ids.length > AGENT_MAX_SITES) return { error: "too_many_sites" };
  const maxMinutes = b.maxMinutes === undefined ? AGENT_DEFAULT_MINUTES : Number(b.maxMinutes);
  if (!Number.isInteger(maxMinutes) || maxMinutes < AGENT_MIN_MINUTES || maxMinutes > AGENT_MAX_MINUTES) return { error: "invalid_minutes" };
  const days = b.days === undefined ? AGENT_DEFAULT_DAYS : Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > AGENT_MAX_DAYS) return { error: "invalid_days" };
  const ratePerMinute = b.ratePerMinute === undefined ? AGENT_DEFAULT_RATE : Number(b.ratePerMinute);
  if (!Number.isInteger(ratePerMinute) || ratePerMinute < AGENT_MIN_RATE || ratePerMinute > AGENT_MAX_RATE) return { error: "invalid_rate" };
  return { name, siteIds: ids, maxMinutes, autoApprove: b.autoApprove === true, days, ratePerMinute };
}

/** The minutes an agent asks for, held to what its token allows; null when it is not a number in range. */
export function agentMinutes(v: unknown, maxMinutes: number): number | null {
  const n = v === undefined ? AGENT_DEFAULT_MINUTES : Number(v);
  if (!Number.isInteger(n) || n < AGENT_MIN_MINUTES) return null;
  return Math.min(n, maxMinutes);
}

/** What a token may do per minute: all calls, and a tenth of that (at least 1) for the ones that make something. */
export function agentRates(ratePerMinute: number): { perMinute: number; perMinuteAction: number } {
  return { perMinute: ratePerMinute, perMinuteAction: Math.max(1, Math.floor(ratePerMinute / 10)) };
}
