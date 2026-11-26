import { describe, it, expect } from "vitest";
import { grantsToCsv } from "./grant-csv";
import { csvEscape } from "@/lib/audit/query";
import type { GrantRowJSON } from "./grant-rows";

const row: GrantRowJSON = {
  id: "g1", userId: "u1", siteId: "s1", kind: "recurring", state: "scheduled", reason: "off_schedule",
  startsAt: null, endsAt: "2026-12-01T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", endedAt: null,
  days: "Mon–Fri", hours: "09:00–18:00", zone: "Europe/Istanbul", nextStart: null,
  note: "=cmd, ticket", denyReason: null, permanent: false, soon: false,
  ticketRef: "CHG0030001", ticket: null, ticketVerified: true, revokeReason: null, passwordCheckout: true, checkoutMinutes: null,
};

describe("grantsToCsv", () => {
  it("writes one escaped line per grant", () => {
    const csv = grantsToCsv(
      [row],
      new Map([["u1", { name: "Demo", email: "d@x.io", role: "VENDOR" }]]),
      new Map([["s1", { id: "s1", name: "DC-RDP", proto: "RDP", remote: true, host: "10.0.0.2:3389", icon: "directory", color: "violet" as const, logoUrl: null, logoBg: null }]]),
      csvEscape,
    );
    const [head, line] = csv.trim().split("\n");
    expect(head.split(",")[0]).toBe("user");
    expect(line).toContain("Demo,d@x.io,VENDOR,DC-RDP,10.0.0.2:3389,recurring,scheduled,off_schedule");
    expect(line).toContain("Mon–Fri 09:00–18:00 (Europe/Istanbul),CHG0030001,");
    expect(line).toContain(`"'=cmd, ticket"`); // formula guard + quoting
  });
});
