import { describe, expect, it } from "vitest";
import { decisionAllowed, isStale, nextOpening, outcomeFor, remindersDue, summarize } from "./plan";

const day = 86_400_000;

describe("access review rules", () => {
  it("never lets a reviewer decide on their own access", () => {
    expect(decisionAllowed({ userId: "u1", directoryManaged: false }, "u1", "keep")).toBe("own_access");
    expect(decisionAllowed({ userId: "u1", directoryManaged: false }, "u2", "revoke")).toBeNull();
  });
  it("sends directory grants to the directory instead of revoking them", () => {
    expect(decisionAllowed({ userId: "u1", directoryManaged: true }, "u2", "revoke")).toBe("directory_managed");
    expect(decisionAllowed({ userId: "u1", directoryManaged: true }, "u2", "ad_remove")).toBeNull();
    expect(decisionAllowed({ userId: "u1", directoryManaged: false }, "u2", "ad_remove")).toBe("not_directory");
  });
  it("revokes what nobody answered only when the review says so, never a directory grant or a reviewer's own", () => {
    expect(outcomeFor({ decision: null, directoryManaged: false }, "revoke")).toBe("auto_revoked");
    expect(outcomeFor({ decision: null, directoryManaged: false }, "keep")).toBe("unanswered");
    expect(outcomeFor({ decision: null, directoryManaged: true }, "revoke")).toBe("unanswered");
    expect(outcomeFor({ decision: "limit", directoryManaged: false }, "revoke")).toBe("limited");
    expect(outcomeFor({ decision: null, directoryManaged: false, userRole: "ADMIN" }, "revoke"), "a reviewer's own grant").toBe("unanswered");
    expect(outcomeFor({ decision: "revoke", directoryManaged: false, userRole: "OPERATOR" }, "revoke")).toBe("revoked");
  });
  it("marks a grant unused for 90 days, or never used, as stale", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date(now.getTime() - 91 * day), now)).toBe(true);
    expect(isStale(new Date(now.getTime() - 10 * day), now)).toBe(false);
  });
  it("reminds a week and a day before, once each", () => {
    const due = new Date("2027-01-15T12:00:00Z");
    expect(remindersDue(due, 0, new Date(due.getTime() - 10 * day))).toBe(0);
    expect(remindersDue(due, 0, new Date(due.getTime() - 6 * day))).toBe(1);
    expect(remindersDue(due, 1, new Date(due.getTime() - 6 * day))).toBe(0);
    expect(remindersDue(due, 1, new Date(due.getTime() - 3600_000))).toBe(2);
    expect(remindersDue(due, 3, new Date(due.getTime() - 3600_000))).toBe(0);
  });
  it("opens the next recurring review a period later", () => {
    expect(nextOpening(new Date("2027-01-31T09:00:00Z"), "quarterly").toISOString().slice(0, 7)).toBe("2027-05");
    expect(nextOpening(new Date("2027-01-10T09:00:00Z"), "yearly").toISOString().slice(0, 10)).toBe("2028-01-10");
  });
  it("counts outcomes", () => {
    expect(summarize(["kept", "revoked", "kept"])).toEqual({ total: 3, kept: 2, revoked: 1 });
  });
});
