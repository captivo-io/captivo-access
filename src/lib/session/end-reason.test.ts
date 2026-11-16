import { describe, expect, it } from "vitest";
import { sessionEndMessage } from "./end-reason";

describe("sessionEndMessage", () => {
  it("says why for every reason the recheck can give", () => {
    for (const r of ["expired", "off_schedule", "revoked", "denied", "no_grant", "pending_approval", "not_yet", "user_disabled", "ip_not_allowed", "signed_out"]) {
      expect(sessionEndMessage(r)).not.toBe(sessionEndMessage("something-else"));
    }
    expect(sessionEndMessage("something-else")).toMatch(/no longer allowed/);
  });
});
