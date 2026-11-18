import { describe, expect, it } from "vitest";
import { closeRefusal, FRESH_AUTH_MS, restorableUntil, type CloseFacts } from "./close-gate";

const now = new Date("2026-11-18T12:00:00Z");
const ok: CloseFacts = { multiTenant: true, tenantId: "t1", slug: "acme", role: "ADMIN", support: false, sessionCreatedAt: new Date(now.getTime() - 60_000), now };

describe("closeRefusal", () => {
  it("lets a recently signed-in admin close with the right address", () => {
    expect(closeRefusal(ok, "acme")).toBeNull();
    expect(closeRefusal(ok)).toBeNull();
  });

  it("is not offered on self-host or for the reserved tenants", () => {
    expect(closeRefusal({ ...ok, multiTenant: false }, "acme")).toBe("not_available");
    expect(closeRefusal({ ...ok, tenantId: "platform" }, "acme")).toBe("not_available");
    expect(closeRefusal({ ...ok, tenantId: "default" }, "acme")).toBe("not_available");
  });

  it("is for admins only", () => {
    expect(closeRefusal({ ...ok, role: "OPERATOR" }, "acme")).toBe("forbidden");
  });

  it("refuses a support session even though it is an admin", () => {
    expect(closeRefusal({ ...ok, support: true }, "acme")).toBe("support_session");
  });

  it("asks for a fresh sign-in once the session is older than the window", () => {
    expect(closeRefusal({ ...ok, sessionCreatedAt: new Date(now.getTime() - FRESH_AUTH_MS - 1) }, "acme")).toBe("reauth_required");
    expect(closeRefusal({ ...ok, sessionCreatedAt: null }, "acme")).toBe("reauth_required");
  });

  it("needs the workspace address typed exactly", () => {
    expect(closeRefusal(ok, "Acme")).toBe("confirm_mismatch");
    expect(closeRefusal(ok, "")).toBe("confirm_mismatch");
  });
});

describe("restorableUntil", () => {
  it("adds the purge window", () => {
    expect(restorableUntil(now, 30).toISOString()).toBe("2026-12-18T12:00:00.000Z");
  });
});
