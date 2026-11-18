import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  own: null as null | Record<string, unknown>,
  platform: null as null | Record<string, unknown>,
  fallback: false,
  sentWith: [] as string[],
}));
vi.mock("@/lib/db", () => ({ db: { smtpConfig: { findUnique: async () => h.own } } }));
vi.mock("@/lib/tenant/context", () => ({ currentTenantId: () => "t1" }));
vi.mock("@/lib/tenant/enabled", () => ({ multiTenantEnabled: () => true }));
vi.mock("@/lib/tenant/constants", () => ({ PLATFORM_TENANT_ID: "platform" }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/platform/config", () => ({ getPlatformConfig: async () => ({ smtpFallback: h.fallback }) }));
vi.mock("@/lib/platform/sql", () => ({ platformSmtpConfig: async () => h.platform }));
vi.mock("nodemailer", () => ({
  default: { createTransport: (o: { host: string }) => ({ sendMail: async () => { h.sentWith.push(o.host); return { response: "250 2.0.0 OK" }; } }) },
}));

import { sendTestEmail, sendingMode, sendMail } from "./mailer";

const own = { host: "smtp.acme.test", port: 587, secure: false, username: "u", password: "p", fromName: "Acme", fromEmail: "no-reply@acme.test", enabled: false };
const platform = { ...own, host: "smtp.captivo.test", enabled: true };

describe("mailer", () => {
  beforeEach(() => { h.own = null; h.platform = null; h.fallback = false; h.sentWith = []; });

  it("names who sends the mail", async () => {
    expect(await sendingMode()).toBe("none");
    h.own = own; h.platform = platform; h.fallback = true;
    expect(await sendingMode()).toBe("platform");
    h.own = { ...own, enabled: true };
    expect(await sendingMode()).toBe("own");
  });

  it("tests the workspace's own settings, never the platform fallback", async () => {
    h.own = own; h.platform = platform; h.fallback = true;
    expect(await sendTestEmail("a@acme.test")).toEqual({ sent: true, response: "250 2.0.0 OK" });
    expect(h.sentWith).toEqual(["smtp.acme.test"]);
    // Ordinary mail still goes through the fallback while the own server is off.
    await sendMail({ to: "a@acme.test", subject: "s", html: "", text: "" });
    expect(h.sentWith).toEqual(["smtp.acme.test", "smtp.captivo.test"]);
  });

  it("says when there is nothing to test", async () => {
    expect(await sendTestEmail("a@acme.test")).toEqual({ sent: false, reason: "not_configured" });
  });
});
