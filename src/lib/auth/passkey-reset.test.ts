import { describe, it, expect } from "vitest";
import { resetRefusal } from "./passkey-reset";

const base = { id: "u2", status: "ACTIVE", centerRole: null, role: "VENDOR" as const };

describe("resetRefusal", () => {
  it("lets an admin reset someone else's passkeys", () => {
    expect(resetRefusal("u1", base)).toBeNull();
    expect(resetRefusal("u1", { ...base, role: "ADMIN" })).toBeNull();
  });
  it("refuses your own account, Captivo ID members and disabled people", () => {
    expect(resetRefusal("u2", base)).toBe("cannot_reset_self");
    expect(resetRefusal("u1", { ...base, centerRole: "MEMBER" })).toBe("managed_by_center");
    expect(resetRefusal("u1", { ...base, status: "DISABLED" })).toBe("user_disabled");
  });
});
