import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const SRC = readFileSync(path.join(__dirname, "route.ts"), "utf-8");

// Mocked so the two behavioural cases below can drive the handler directly:
// withTenantRoute is stripped to a pass-through (its own tenant-resolution
// behaviour is exercised elsewhere), and the host/claim decisions are put
// under the test's control instead of the real tenant scope and cookie
// secret. `createTenant` is never reached by any case here.
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
// signWorkspaceClaim comes through the partial mock untouched (the factory
// spreads the real module), so the token below is the real thing.
import { readWorkspaceClaim, signWorkspaceClaim } from "@/lib/signup/workspace-claim";
import { provisionEntitledWorkspace } from "@/lib/signup/entitled-flow";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";

// NextRequest, not a plain Request: the handler reads the claim off
// `req.cookies`, which only NextRequest parses from the `Cookie` header.
function req(body: unknown, cookie?: string) {
  return new NextRequest("http://x/api/workspace/create", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
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

// The claim check is the only thing standing between this route and "anyone
// who can POST creates a workspace", and until now every test here handed it
// a canned answer. These drive it with a REAL signed cookie instead, so the
// route, the cookie jar and the verifier are exercised together.
describe("the handoff cookie the callback issued", () => {
  const SECRET = "test-workspace-claim-secret";

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("CAPTIVO_ID_CLIENT_SECRET", SECRET);
    (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue(PLATFORM_TENANT_ID);
    // Not injected: the real verifier runs against the real token below.
    const real = await vi.importActual<typeof import("@/lib/signup/workspace-claim")>("@/lib/signup/workspace-claim");
    (readWorkspaceClaim as ReturnType<typeof vi.fn>).mockImplementation(real.readWorkspaceClaim);
    (provisionEntitledWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, inviteUrl: "https://acme.cloud.captivo.io/invite/tok", linked: true,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("gets past the claim check and provisions for the organisation it names", async () => {
    const token = signWorkspaceClaim({ org: "org_1", orgName: "Acme", email: "a@b.co" }, SECRET);

    const res = await POST(req({ slug: "acme" }, `captivo_workspace=${token}`) as never);

    // 201, not the 401 the endpoint answered for as long as the cookie was
    // scoped to a path that never reached it.
    expect(res.status).toBe(201);
    expect(provisionEntitledWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_1", adminEmail: "a@b.co" }),
      expect.anything(),
    );
  });

  it("is cleared at a path that covers this endpoint, not just the page", async () => {
    // Clearing at "/workspace" while the cookie lives at "/" leaves a spent
    // handoff in the jar for its full 15 minutes.
    const token = signWorkspaceClaim({ org: "org_1", orgName: "Acme", email: "a@b.co" }, SECRET);

    const res = await POST(req({ slug: "acme" }, `captivo_workspace=${token}`) as never);

    // Read off the wire (Set-Cookie) rather than through a helper, so what is
    // asserted is what the browser is actually told.
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("captivo_workspace="));
    expect(cleared, "the spent handoff is not cleared at all").toBeDefined();
    expect(cleared).toMatch(/^captivo_workspace=;/);
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/;\s*Path=\/(?:;|$)/i);
  });

  it("refuses a token signed with a different secret", async () => {
    const forged = signWorkspaceClaim({ org: "org_1", orgName: "Acme", email: "a@b.co" }, "some-other-secret");

    const res = await POST(req({ slug: "acme" }, `captivo_workspace=${forged}`) as never);

    expect(res.status).toBe(401);
    expect(provisionEntitledWorkspace).not.toHaveBeenCalled();
  });
});

describe("slug refusals name their own cause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (currentTenantId as ReturnType<typeof vi.fn>).mockReturnValue(PLATFORM_TENANT_ID);
    (readWorkspaceClaim as ReturnType<typeof vi.fn>).mockReturnValue({
      org: "org_1", orgName: "Acme", email: "a@b.co", exp: Date.now() + 60_000,
    });
  });

  it("tells a reserved slug apart from a malformed one", async () => {
    // "admin" is perfectly well-formed, so answering invalid_slug ("use
    // lowercase letters, digits and hyphens only") sent the person hunting
    // for a typo that was not there.
    const reserved = await POST(req({ slug: "admin" }) as never);
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ error: "reserved_slug" });

    const malformed = await POST(req({ slug: "Not A Slug" }) as never);
    expect(await malformed.json()).toEqual({ error: "invalid_slug" });
  });
});
