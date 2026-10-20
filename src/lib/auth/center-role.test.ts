import { describe, it, expect } from "vitest";
import { centerRoleOf, consoleRoleAllowed, consoleRolesFor, reconcileCenterRole } from "./center-role";

describe("the centre's role on the console", () => {
  it("owner and admin start as ADMIN, a member as STAFF; an unknown role is a member", () => {
    expect(reconcileCenterRole({ role: "STAFF", centerRole: null, status: "ACTIVE" }, "OWNER")).toEqual({ outcome: "update", role: "ADMIN", centerRole: "OWNER", status: "ACTIVE" });
    expect(reconcileCenterRole({ role: "ADMIN", centerRole: null, status: "ACTIVE" }, "MEMBER")).toEqual({ outcome: "update", role: "STAFF", centerRole: "MEMBER", status: "ACTIVE" });
    expect(centerRoleOf("AUDITOR")).toBe("MEMBER");
    expect(centerRoleOf(undefined)).toBe("MEMBER");
  });

  it("keeps the console's own narrowing while the centre role is unchanged", () => {
    expect(reconcileCenterRole({ role: "OPERATOR", centerRole: "ADMIN", status: "ACTIVE" }, "ADMIN")).toEqual({ outcome: "unchanged" });
    expect(reconcileCenterRole({ role: "AUDITOR", centerRole: "MEMBER", status: "ACTIVE" }, "MEMBER")).toEqual({ outcome: "unchanged" });
  });

  it("a role change at the centre resets the console role: promotion and demotion both land", () => {
    expect(reconcileCenterRole({ role: "STAFF", centerRole: "MEMBER", status: "ACTIVE" }, "ADMIN")).toEqual({ outcome: "update", role: "ADMIN", centerRole: "ADMIN", status: "ACTIVE" });
    expect(reconcileCenterRole({ role: "ADMIN", centerRole: "OWNER", status: "ACTIVE" }, "MEMBER")).toEqual({ outcome: "update", role: "STAFF", centerRole: "MEMBER", status: "ACTIVE" });
  });

  it("the ceiling: a member is never ADMIN, an organisation member is never a VENDOR", () => {
    expect(consoleRolesFor("MEMBER")).toEqual(["OPERATOR", "AUDITOR", "STAFF"]);
    expect(consoleRolesFor("ADMIN")).toEqual(["ADMIN", "OPERATOR", "AUDITOR", "STAFF"]);
    expect(consoleRoleAllowed("OWNER", "VENDOR")).toBe(false);
    expect(consoleRoleAllowed("MEMBER", "ADMIN")).toBe(false);
    expect(consoleRoleAllowed("MEMBER", "OPERATOR")).toBe(true);
    // A console ADMIN the centre now calls a member is brought under the ceiling.
    expect(reconcileCenterRole({ role: "ADMIN", centerRole: "MEMBER", status: "ACTIVE" }, "MEMBER")).toEqual({ outcome: "update", role: "STAFF", centerRole: "MEMBER", status: "ACTIVE" });
  });

  it("a centre-managed user without a grant was removed there; a local user is left alone", () => {
    expect(reconcileCenterRole({ role: "ADMIN", centerRole: "ADMIN", status: "ACTIVE" }, null)).toEqual({ outcome: "revoked" });
    expect(reconcileCenterRole({ role: "ADMIN", centerRole: null, status: "ACTIVE" }, null)).toEqual({ outcome: "unchanged" });
  });

  it("a disabled centre-managed user arriving with a grant is re-enabled; platform staff are never touched", () => {
    expect(reconcileCenterRole({ role: "STAFF", centerRole: "MEMBER", status: "DISABLED" }, "MEMBER")).toEqual({ outcome: "update", role: "STAFF", centerRole: "MEMBER", status: "ACTIVE" });
    expect(reconcileCenterRole({ role: "PLATFORM", centerRole: null, status: "ACTIVE" }, "MEMBER")).toEqual({ outcome: "unchanged" });
  });
});
