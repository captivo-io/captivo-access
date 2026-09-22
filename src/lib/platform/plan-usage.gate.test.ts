import { describe, it, expect, vi, beforeEach } from "vitest";

const multiTenant = vi.fn();
const envelope = vi.fn();

vi.mock("@/lib/tenant/enabled", () => ({ multiTenantEnabled: () => multiTenant() }));
vi.mock("@/lib/tenant/envelope", () => ({ tenantEnvelope: () => envelope() }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));
vi.mock("@/lib/db", () => ({
  db: { tenant: { findUnique: async () => ({ plan: "free" }) } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  envelope.mockResolvedValue({ limits: { maxSites: 5 }, capabilities: {} });
});

describe("where the allowance line is silent", () => {
  it("says nothing on a self-hosted installation", async () => {
    // The tenant machinery is a no-op there and nothing is limited, so a line
    // about an allowance would be inventing one. Asserted rather than assumed:
    // this is the question the product owner asked before shipping it.
    multiTenant.mockReturnValue(false);
    const { planUsage } = await import("./plan-usage");
    expect(await planUsage("maxSites", 3)).toBeNull();
  });

  it("does not even ask the envelope when self-hosted", async () => {
    // Order matters for a page that renders on every request: the gate comes
    // before the lookup, not after it.
    multiTenant.mockReturnValue(false);
    const { planUsage } = await import("./plan-usage");
    await planUsage("maxSites", 3);
    expect(envelope).not.toHaveBeenCalled();
  });

  it("says nothing on a cloud plan with no cap on that key", async () => {
    multiTenant.mockReturnValue(true);
    envelope.mockResolvedValue({ limits: {}, capabilities: {} });
    const { planUsage } = await import("./plan-usage");
    expect(await planUsage("maxSites", 3)).toBeNull();
  });

  it("speaks when the cloud plan does cap that key", async () => {
    multiTenant.mockReturnValue(true);
    const { planUsage } = await import("./plan-usage");
    expect(await planUsage("maxSites", 3)).toEqual({ used: 3, max: 5, plan: "free" });
  });
});
