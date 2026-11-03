import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    session: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/policy/session-policy", () => ({
  getSessionPolicy: async () => ({ maxConcurrentPerUser: 1, idleTimeoutMinutes: null, maxSessionHours: null }),
  sessionTtlMs: () => 3600e3,
  idleExpired: () => false,
  evictionIds: () => [],
}));
vi.mock("@/lib/auth/captivo-id-client", () => ({ reportLastProduct: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { createSession, getSessionUser } from "../session";

beforeEach(() => vi.clearAllMocks());

describe("console sessions and app sign-ins stay apart", () => {
  it("an app token is never a console cookie", async () => {
    findFirst.mockResolvedValue({ id: "s1", mobile: true, expiresAt: new Date(Date.now() + 3600e3), lastSeenAt: new Date(), user: { status: "ACTIVE" } });
    expect(await getSessionUser("app-token")).toBeNull();
  });

  it("a console session still works", async () => {
    findFirst.mockResolvedValue({ id: "s1", mobile: false, expiresAt: new Date(Date.now() + 3600e3), lastSeenAt: new Date(), user: { id: "u1", status: "ACTIVE" } });
    expect((await getSessionUser("web-token"))?.id).toBe("u1");
  });

  it("the concurrent-session cap does not count the phone", async () => {
    findMany.mockResolvedValue([]);
    await createSession("u1");
    expect(findMany.mock.calls[0][0].where).toMatchObject({ userId: "u1", mobile: false });
  });
});
