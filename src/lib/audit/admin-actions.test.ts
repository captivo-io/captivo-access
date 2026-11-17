import { describe, it, expect } from "vitest";
import { adminActionLabel, adminCategory, adminMergedSummary, isAdminCategory } from "./admin-actions";

describe("adminActionLabel", () => {
  it("maps known actions to human labels", () => {
    expect(adminActionLabel("session.terminate")).toBe("Session terminated");
    expect(adminActionLabel("grant.update")).toBe("Grant updated");
    expect(adminActionLabel("resource.vault_update")).toBe("Resource credential updated");
    expect(adminActionLabel("config.smtp_update")).toBe("SMTP settings updated");
    expect(adminActionLabel("recording.delete")).toBe("Recording deleted");
  });
  it("falls back to the raw action for unknown values", () => {
    expect(adminActionLabel("something.new")).toBe("something.new");
  });
});

describe("adminCategory", () => {
  it("files each action under its page filter", () => {
    expect(adminCategory("connector.pairing_delete")).toBe("connector");
    expect(adminCategory("config.log_level_reset")).toBe("connector");
    expect(adminCategory("recording.erasure_requested")).toBe("recording");
    expect(adminCategory("grant.revoke")).toBe("access");
    expect(adminCategory("session.terminate")).toBe("access");
    expect(adminCategory("resource.vault_update")).toBe("resource");
    expect(adminCategory("config.sso_remove")).toBe("identity");
    expect(adminCategory("authsession.revoke")).toBe("identity");
    expect(adminCategory("config.smtp_update")).toBe("settings");
    expect(adminCategory("something.new")).toBe("settings");
  });
  it("accepts only the known category names", () => {
    expect(isAdminCategory("recording")).toBe(true);
    expect(isAdminCategory("toString")).toBe(false);
    expect(isAdminCategory(null)).toBe(false);
  });
});

describe("adminMergedSummary", () => {
  it("keeps a single entry's summary", () => {
    expect(adminMergedSummary("grant.revoke", 1, "Revoked x")).toBe("Revoked x");
  });
  it("words a merged run of a known action", () => {
    expect(adminMergedSummary("recording.erasure_requested", 9, "…")).toBe("Requested erasure of 9 recordings (applied when their connectors confirm)");
  });
  it("falls back to the count and the newest summary", () => {
    expect(adminMergedSummary("user.update", 3, "Changed role")).toBe("3 times. Latest: Changed role");
  });
});
