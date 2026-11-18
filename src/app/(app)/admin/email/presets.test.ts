import { describe, it, expect } from "vitest";
import { presetFor, PRESETS } from "./presets";

describe("SMTP presets", () => {
  it("reads the preset back from the saved host", () => {
    expect(presetFor("smtp.office365.com")).toBe("m365");
    expect(presetFor("SMTP.GMAIL.COM")).toBe("google");
    expect(presetFor("smtp.sendgrid.net")).toBe("sendgrid");
    expect(presetFor("email-smtp.eu-central-1.amazonaws.com")).toBe("ses");
    expect(presetFor("mail.acme.local")).toBe("custom");
    expect(presetFor("")).toBeNull();
  });
  it("only offers what can be stored: STARTTLS or TLS, no plain mode", () => {
    for (const p of PRESETS) if (p.port) expect([587, 465]).toContain(p.port);
  });
});
