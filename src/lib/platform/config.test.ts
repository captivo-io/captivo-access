import { describe, it, expect } from "vitest";
import { activeAnnouncement, parseNewTenantDefaults, EMPTY_CONFIG } from "./config";

describe("activeAnnouncement", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  it("is null without text or after 'until'", () => {
    expect(activeAnnouncement(EMPTY_CONFIG, now)).toBeNull();
    expect(activeAnnouncement({ ...EMPTY_CONFIG, announcementText: "x", announcementUntil: new Date("2026-09-10T11:00:00Z") }, now)).toBeNull();
  });
  it("returns text + level while active", () => {
    expect(activeAnnouncement({ ...EMPTY_CONFIG, announcementText: "Maintenance", announcementLevel: "warn", announcementUntil: new Date("2026-09-11T00:00:00Z") }, now)).toEqual({ text: "Maintenance", level: "warn" });
    expect(activeAnnouncement({ ...EMPTY_CONFIG, announcementText: "Hi" }, now)).toEqual({ text: "Hi", level: "info" });
  });
});

describe("parseNewTenantDefaults", () => {
  it("keeps only known, well-formed keys and null when empty", () => {
    expect(parseNewTenantDefaults(null)).toBeNull();
    expect(parseNewTenantDefaults({ recordingMode: "", auditRetentionDays: "" })).toBeNull();
    expect(parseNewTenantDefaults({ recordingMode: "required", auditRetentionDays: "90", maxGrantDays: 7, requireRequestJustification: false, displayTimezone: "Europe/Istanbul", bogus: 1 }))
      .toEqual({ recordingMode: "required", auditRetentionDays: 90, maxGrantDays: 7, requireRequestJustification: false, displayTimezone: "Europe/Istanbul" });
    expect(parseNewTenantDefaults({ recordingRetentionDays: -5 })).toBeNull();
  });

  it("drops a display timezone Intl does not know", () => {
    expect(parseNewTenantDefaults({ displayTimezone: "Mars/Olympus" })).toBeNull();
    expect(parseNewTenantDefaults({ displayTimezone: "America/New_York" })).toEqual({ displayTimezone: "America/New_York" });
  });
});
