import { vi, describe, it, expect, beforeEach } from "vitest";

const seen: { tenant: string | null }[] = [];
vi.mock("@/lib/tenant/internal", () => ({
  requireDataplaneSecret: (h: unknown) => h,
  // Run the resolver, as the real wrapper does, so the test sees which workspace it picks.
  withTenantFrom: (resolve: (r: Request) => Promise<string | null>) => (h: (r: Request) => Promise<Response>) => async (r: Request) => {
    seen.push({ tenant: await resolve(r) });
    return h(r);
  },
}));
const guestAuthz = vi.fn();
vi.mock("@/lib/live/invites", () => ({ guestAuthz: (...a: unknown[]) => guestAuthz(...a) }));

import { POST } from "./route";

const PASS = `tenant-1.cmwx1a2b3c4d5e6f7g8h.${"a".repeat(43)}`;
function req(body: unknown) {
  return new Request("http://manager/api/internal/gateway/guest-authz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/gateway/guest-authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seen.length = 0;
    guestAuthz.mockResolvedValue({ allow: true, viewerId: "guest:cmwx1a2b3c4d5e6f7g8h", name: "Ayşe", until: "2026-11-23T12:00:00.000Z" });
  });

  it("answers in the pass's own workspace", async () => {
    const res = await (await POST(req({ token: PASS, sessionId: "s1", siteId: "site1" }) as never)).json();
    expect(res).toMatchObject({ allow: true, viewerId: "guest:cmwx1a2b3c4d5e6f7g8h" });
    expect(seen[0].tenant).toBe("tenant-1");
    expect(guestAuthz).toHaveBeenCalledWith(PASS, "s1", "site1");
  });

  it("refuses without the session and the site (an old data plane fails closed)", async () => {
    expect(await (await POST(req({ token: PASS, sessionId: "s1" }) as never)).json()).toEqual({ allow: false });
    expect(await (await POST(req({ token: PASS, siteId: "site1" }) as never)).json()).toEqual({ allow: false });
    expect(guestAuthz).not.toHaveBeenCalled();
  });

  it("finds no workspace for something that is not a pass", async () => {
    await POST(req({ token: "garbage", sessionId: "s1", siteId: "site1" }) as never);
    expect(seen[0].tenant).toBeNull();
  });
});
