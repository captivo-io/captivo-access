import { describe, expect, it } from "vitest";
import { mintRdpTicket, RDP_TICKET_TTL_MS } from "./rdp-ticket";

// dataplane/rdpticket_test.go verifies this exact token, so the two sides agree on the format.
const VECTOR = "cr1.eyJ0IjoidDEiLCJzIjoic2l0ZTEiLCJ1IjoidXNlcjEiLCJlIjoxODAwMDAwMDAwLCJuIjoiMDAxMTIyMzM0NDU1NjY3NyJ9.F3LYViLlvxkp6Znchtn6_QuFODH5UhNzRcn-vt9PQIM";

describe("mintRdpTicket", () => {
  it("matches the data plane's test vector", () => {
    const now = new Date(1_800_000_000_000 - RDP_TICKET_TTL_MS);
    const t = mintRdpTicket({ tenantId: "t1", siteId: "site1", userId: "user1" }, { secret: "test-dataplane-secret", now, nonce: "0011223344556677" });
    expect(t.token).toBe(VECTOR);
    expect(t.expiresAt.getTime()).toBe(1_800_000_000_000);
  });

  it("gives every download its own token", () => {
    const now = new Date();
    const a = mintRdpTicket({ tenantId: "t", siteId: "s", userId: "u" }, { secret: "k", now });
    const b = mintRdpTicket({ tenantId: "t", siteId: "s", userId: "u" }, { secret: "k", now });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^cr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });
});
