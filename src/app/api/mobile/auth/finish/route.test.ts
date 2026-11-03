import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenant/request", () => ({ withTenantRoute: (h: unknown) => h }));
const jar = new Map<string, string>();
const set = vi.fn((name: string, value: string) => { if (value) jar.set(name, value); else jar.delete(name); });
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined), set }) }));
vi.mock("@/lib/auth/cookies", () => ({ cookieSecure: async () => true, cookieDomain: () => ".cloud.example" }));
const getSessionUser = vi.fn();
const destroySession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ SESSION_COOKIE: "ca_session", getSessionUser: (...a: unknown[]) => getSessionUser(...a), destroySession: (...a: unknown[]) => destroySession(...a) }));
vi.mock("@/lib/db", () => ({ db: { session: { findFirst: vi.fn(async () => ({ amr: ["mfa"] })) } } }));
const issueMobileCode = vi.fn<(...a: unknown[]) => Promise<string>>(async () => "CODE");
vi.mock("@/lib/mobile/session", () => ({ issueMobileCode: (...a: unknown[]) => issueMobileCode(...a) }));

import { GET } from "./route";
import { signHandoff } from "@/lib/mobile/handoff";

const challenge = "c".repeat(43);
const req = () => new Request("https://acme.cloud.example/api/mobile/auth/finish") as never;
const location = (r: Response) => r.headers.get("location");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SESSION_SECRET", "x".repeat(32));
  jar.clear();
  jar.set("ca_mobile_handoff", signHandoff(challenge));
  jar.set("ca_session", "web-token");
  getSessionUser.mockResolvedValue({ id: "u1", role: "ADMIN" });
});

describe("GET /api/mobile/auth/finish", () => {
  it("hands the app a code bound to its challenge and leaves no browser session behind", async () => {
    const res = await GET(req());
    expect(location(res)).toBe("captivo://auth/access?code=CODE");
    expect(issueMobileCode).toHaveBeenCalledWith("u1", challenge, expect.objectContaining({ amr: ["mfa"] }));
    expect(destroySession).toHaveBeenCalledWith("web-token");
    expect(jar.has("ca_session")).toBe(false);
    expect(jar.has("ca_mobile_handoff")).toBe(false);
  });

  it("without the hand-off cookie there is no code", async () => {
    jar.delete("ca_mobile_handoff");
    expect(location(await GET(req()))).toBe("captivo://auth/access?error=expired");
    expect(issueMobileCode).not.toHaveBeenCalled();
  });

  it("a sign-in that did not finish goes back to the app as an error", async () => {
    getSessionUser.mockResolvedValue(null);
    expect(location(await GET(req()))).toBe("captivo://auth/access?error=signin");
  });

  it("a vendor gets no app token", async () => {
    getSessionUser.mockResolvedValue({ id: "v1", role: "VENDOR" });
    expect(location(await GET(req()))).toBe("captivo://auth/access?error=not_admin");
    expect(issueMobileCode).not.toHaveBeenCalled();
  });
});
