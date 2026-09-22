import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ db: { tenant: { findUnique: vi.fn() } } }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: vi.fn(() => "t_1") }));
vi.mock("@/lib/auth/captivo-id-client", () => ({ fetchCenterPicture: vi.fn() }));

import { getCenterPicture } from "./center-picture";
import { db } from "@/lib/db";
import { fetchCenterPicture } from "@/lib/auth/captivo-id-client";

const PICTURE = { entitlements: [{ product: "ACCESS", plan: "free", limits: null, expiresAt: null }], links: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.tenant.findUnique).mockResolvedValue({ captivoOrgId: "org_1" } as never);
  vi.mocked(fetchCenterPicture).mockResolvedValue(PICTURE as never);
});

describe("getCenterPicture", () => {
  it("asks the centre about the tenant's organisation", async () => {
    // The centre knows organisations, not Access tenants. Sending the tenant id
    // would return nothing for everyone, and quietly: an empty answer is
    // indistinguishable from "not entitled".
    await getCenterPicture();
    expect(fetchCenterPicture).toHaveBeenCalledWith("org_1", expect.any(Number));
  });

  it("does not ask at all when the tenant has no organisation", async () => {
    vi.mocked(db.tenant.findUnique).mockResolvedValue({ captivoOrgId: null } as never);
    await expect(getCenterPicture()).resolves.toBeNull();
    expect(fetchCenterPicture).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when the lookup fails", async () => {
    // This is awaited from the console layout; an escaping exception would
    // blank every page, not one.
    vi.mocked(db.tenant.findUnique).mockRejectedValueOnce(new Error("db down"));
    await expect(getCenterPicture()).resolves.toBeNull();
  });

  it("bounds the centre call below a second", async () => {
    // A wedged centre -- accepting connections, never answering -- must not add
    // a visible pause to every console page.
    await getCenterPicture();
    expect(vi.mocked(fetchCenterPicture).mock.calls.length).toBe(1);
    const [, bound] = vi.mocked(fetchCenterPicture).mock.calls[0] as [string, number];
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThan(1000);
  });
});

describe("the accessor is memoised per request", () => {
  it("keeps the React cache wrapper (source check, not behaviour)", () => {
    // Deliberately a source assertion. React's `cache` only memoises inside a
    // request scope, and under vitest there is none: a cached function called
    // twice here runs its body twice, measured. So the property cannot be
    // observed at this level, and a test that called the accessor twice and
    // expected one lookup would fail on correct code.
    //
    // What this does catch is the regression that matters: someone unwrapping
    // the accessor. Without the wrapper every consumer in one render pays its
    // own database lookup and its own centre call -- and its own timeout when
    // the centre is wedged.
    const SRC = readFileSync(path.join(__dirname, "center-picture.ts"), "utf-8");
    expect(SRC).toMatch(/export const getCenterPicture = cache\(/);
  });
});
