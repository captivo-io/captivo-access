import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROUTE = readFileSync(path.join(__dirname, "route.ts"), "utf-8");
const FORM = readFileSync(path.join(__dirname, "..", "..", "..", "..", "(platform)", "platform", "settings", "platform-config-form.tsx"), "utf-8");

describe("display timezone and announcement times", () => {
  it("the tenant policy route refuses a zone Intl does not know", () => {
    expect(ROUTE).toMatch(/!isValidTimeZone\(body\.displayTimezone\)\)\s*\{\s*return NextResponse\.json\(\{ error: "invalid_timezone" \}/);
  });

  it("the announcement end is typed in the display zone and sent as an instant", () => {
    expect(FORM).toContain("parseDatetimeLocal(s.announcementUntil, tz)");
    expect(FORM).toContain("announcementUntil: until ? until.toISOString() : \"\"");
    expect(FORM).toContain("formatDatetimeLocal(new Date(initial.announcementUntil), tz)");
  });
});
