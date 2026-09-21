import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const SRC = readFileSync(path.join(__dirname, "route.ts"), "utf-8");

// Mocked so the two behavioural cases below can drive the handler directly:
// withTenantRoute is stripped to a pass-through (its own tenant-resolution
// behaviour is exercised elsewhere), and the host/claim decisions are put
// under the test's control instead of the real tenant scope and cookie
// secret. `provisionEntitledWorkspace` and `createTenant` are never reached
// by either case, so they are left real (nothing here calls them).
vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
vi.mock("@/lib/tenant/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant/context")>("@/lib/tenant/context");
  return { ...actual, currentTenantId: vi.fn() };
});
vi.mock("@/lib/signup/workspace-claim", async () => {
  const actual = await vi.importActual<typeof import("@/lib/signup/workspace-claim")>("@/lib/signup/workspace-claim");
  return { ...actual, readWorkspaceClaim: vi.fn() };
});
vi.mock("@/lib/signup/entitled-flow", async () => {
  const actual = await vi.importActual<typeof import("@/lib/signup/entitled-flow")>("@/lib/signup/entitled-flow");
  return { ...actual, provisionEntitledWorkspace: vi.fn() };
});

import { POST } from "./route";
import { currentTenantId } from "@/lib/tenant/context";
import { readWorkspaceClaim } from "@/lib/signup/workspace-claim";
import { provisionEntitledWorkspace } from "@/lib/signup/entitled-flow";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";

// NextRequest, not a plain Request: the handler reads the claim off
// `req.cookies`, which only NextRequest parses from the `Cookie` header.
function req(body: unknown) {
  return new NextRequest("http://x/api/workspace/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace create endpoint", () => {
  it("takes the organisation from the signed claim, never from the body", () => {
    // The body is whatever the browser sent. If organizationId came from
    // there, anyone who could reach this route could create a workspace for
    // an organisation they have no grant for.
    // Asserted POSITIVELY: a negative regex only forbids one spelling, and an
    // implementation that aliased the body first would slip past it.
    expect(SRC).toMatch(/readWorkspaceClaim\(/);
    expect(SRC).toMatch(/organizationId:\s*claim\.org/);
  });

  it("refuses without a valid claim", () => {
    expect(SRC).toMatch(/unauthorized|no_claim/);
  });

  it("only accepts the slug from the body", () => {
    // The slug is the ONE thing the person is allowed to choose here.
    expect(SRC).toMatch(/body\??\.\s*slug|body\["slug"\]/);
  });

  // A source-text assertion here (e.g. `expect(SRC).toMatch(/PLATFORM_TENANT_ID/)`)
  // only proves the token is spelled somewhere in the file -- a guard mutated
  // to `if (cond || true)` keeps that text and still passes. This route's
  // host check is what stops a grant (what an organisation bought) from being
  // treated as membership of whatever tenant the request happened to land on,
  // so it is exercised by actually calling the handler.
  describe("runs on the platform host only", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns 404 and creates nothing when the tenant is not the platform host", async () => {
      (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue("some-customer-tenant");

      const res = await POST(req({ slug: "acme" }) as never);

      expect(res.status).toBe(404);
      // Not merely "no workspace exists" -- the provisioning call itself was
      // never made, and neither was the claim even read.
      expect(readWorkspaceClaim).not.toHaveBeenCalled();
      expect(provisionEntitledWorkspace).not.toHaveBeenCalled();
    });

    it("lets the request through when the tenant is the platform host", async () => {
      (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue(PLATFORM_TENANT_ID);
      // No claim cookie in this request -- the handler should fail on THAT,
      // not on the host check. A 401 here (rather than 404) is exactly the
      // proof that the host check did not stop the request.
      (readWorkspaceClaim as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const res = await POST(req({ slug: "acme" }) as never);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(provisionEntitledWorkspace).not.toHaveBeenCalled();
    });
  });
});
