import { describe, it, expect } from "vitest";
import { AGENT_TOKEN_PREFIX, agentMinutes, agentTokenFrom, hashAgentToken, newAgentToken, parseAgentTokenInput } from "@/lib/agent/tokens";
import { agentCanUse } from "@/lib/agent/sites";

describe("agent tokens", () => {
  it("makes a long random token whose hash and prefix are all that is kept", () => {
    const a = newAgentToken();
    const b = newAgentToken();
    expect(a.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(a.token.length).toBeGreaterThan(40);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashAgentToken(a.token));
    expect(a.hash).not.toContain(a.token);
    expect(a.token.startsWith(a.prefix)).toBe(true);
  });

  it("takes only an agent token from a bearer header", () => {
    expect(agentTokenFrom("Bearer cat_abc")).toBe("cat_abc");
    expect(agentTokenFrom("bearer cat_abc")).toBe("cat_abc");
    expect(agentTokenFrom("Bearer other_token")).toBeNull();
    expect(agentTokenFrom("Basic cat_abc")).toBeNull();
    expect(agentTokenFrom("Bearer cat_a b")).toBeNull();
    expect(agentTokenFrom(`Bearer cat_${"x".repeat(300)}`)).toBeNull();
    expect(agentTokenFrom(null)).toBeNull();
  });

  it("reads a request to make a token, holding it to sane limits", () => {
    const ok = parseAgentTokenInput({ name: " Release  pipeline ", siteIds: ["a", "a", "b"], maxMinutes: 30, days: 14, autoApprove: true });
    expect(ok).toEqual({ name: "Release pipeline", siteIds: ["a", "b"], maxMinutes: 30, autoApprove: true, days: 14, ratePerMinute: 120 });
    expect(parseAgentTokenInput({ name: "x", siteIds: ["a"] })).toEqual({ error: "invalid_name" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: [] })).toEqual({ error: "sites_required" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"], maxMinutes: 2 })).toEqual({ error: "invalid_minutes" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"], maxMinutes: 5000 })).toEqual({ error: "invalid_minutes" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"], days: 365 })).toEqual({ error: "invalid_days" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: Array.from({ length: 51 }, (_, i) => `s${i}`) })).toEqual({ error: "too_many_sites" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"] })).toMatchObject({ autoApprove: false, maxMinutes: 60, days: 30, ratePerMinute: 120 });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"], ratePerMinute: 30 })).toMatchObject({ ratePerMinute: 30 });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"], ratePerMinute: 5 })).toEqual({ error: "invalid_rate" });
    expect(parseAgentTokenInput({ name: "ok", siteIds: ["a"], ratePerMinute: 601 })).toEqual({ error: "invalid_rate" });
  });

  it("holds a request to the token's longest access", () => {
    expect(agentMinutes(30, 60)).toBe(30);
    expect(agentMinutes(600, 60)).toBe(60);
    expect(agentMinutes(undefined, 120)).toBe(60);
    expect(agentMinutes(undefined, 20)).toBe(20);
    expect(agentMinutes(1, 60)).toBeNull();
    expect(agentMinutes("abc", 60)).toBeNull();
    expect(agentMinutes(2.5, 60)).toBeNull();
  });

  it("connects to SSH, tunnels, databases and clusters, not to desktops or web apps", () => {
    expect(agentCanUse({ accessMode: "TUNNEL" })).toBe(true);
    expect(agentCanUse({ accessMode: "GATEWAY", vaultCredential: { protocol: "SSH" } })).toBe(true);
    expect(agentCanUse({ accessMode: "GATEWAY", vaultCredential: { protocol: "RDP" } })).toBe(false);
    expect(agentCanUse({ accessMode: "DATABASE", vaultCredential: { protocol: "POSTGRES" } })).toBe(true);
    expect(agentCanUse({ accessMode: "KUBERNETES" })).toBe(true);
    expect(agentCanUse({ accessMode: "ISOLATED" })).toBe(false);
    expect(agentCanUse({ accessMode: "TRANSPARENT" })).toBe(false);
  });
});
