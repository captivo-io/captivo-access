import { describe, it, expect, vi, afterEach } from "vitest";
import { registerWithCaptivoId } from "./captivo-id-register";

const SAAS_ENV = {
  CAPTIVO_DEPLOYMENT: "saas",
  CAPTIVO_ID_ISSUER: "https://id.captivo.io",
  CAPTIVO_ID_SERVICE_SECRET: "shhh",
};

const INPUT = { email: "owner@acme.co", organizationName: "Acme", name: "Ada Owner" };

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("registerWithCaptivoId", () => {
  it("never calls out on a self-hosted install", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await registerWithCaptivoId(INPUT, { ...SAAS_ENV, CAPTIVO_DEPLOYMENT: "self-hosted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends product ACCESS, emailVerified true, and no password", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ identityId: "i1", organizationId: "o1" }), { status: 201 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    await registerWithCaptivoId(INPUT, SAAS_ENV);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://id.captivo.io/api/register");
    expect((init.headers as Record<string, string>)["X-Captivo-Service"]).toBe("shhh");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      email: "owner@acme.co",
      organizationName: "Acme",
      product: "ACCESS",
      name: "Ada Owner",
      emailVerified: true,
    });
    expect(body).not.toHaveProperty("password");
  });

  it("does not call out when the service secret is missing", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await registerWithCaptivoId(INPUT, { CAPTIVO_DEPLOYMENT: "saas", CAPTIVO_ID_ISSUER: "https://id.captivo.io" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still succeeds when the identity service is unreachable", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("fetch failed"));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(registerWithCaptivoId(INPUT, SAAS_ENV)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs a 409 distinctly from a failure, and still succeeds", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "email_taken" }), { status: 409 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(registerWithCaptivoId(INPUT, SAAS_ENV)).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
