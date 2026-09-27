import { describe, it, expect } from "vitest";
import { buildTransportOptions } from "./transport";

describe("buildTransportOptions", () => {
  it("maps fields with implicit TLS (secure=true)", () => {
    // Strict equality on purpose: an accidentally added transport option is a
    // change in what we hand nodemailer and should be seen here. The three
    // ceilings are part of that contract -- nodemailer applies none by default,
    // and every send happens on a request path (see lib/net/*.test.ts).
    expect(buildTransportOptions({ host: "smtp.example.com", port: 465, secure: true, username: "u", password: "p" }))
      .toEqual({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        auth: { user: "u", pass: "p" },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
  });
  it("keeps secure=false (STARTTLS)", () => {
    expect(buildTransportOptions({ host: "h", port: 587, secure: false, username: "u", password: "p" }).secure).toBe(false);
  });
});
