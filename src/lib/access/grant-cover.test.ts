import { describe, it, expect } from "vitest";
import { grantCovers, grantIsLive } from "./grant-cover";

const now = Date.parse("2026-11-18T12:00:00Z");
const h = (n: number) => now + n * 3_600_000;
const w = (startsAt: number | null, endsAt: number | null, recurring = false) => ({ startsAt, endsAt, recurring });

describe("grantCovers", () => {
  it("a permanent grant covers anything new", () => {
    expect(grantCovers(w(null, null), w(null, h(24)), now)).toBe(true);
    expect(grantCovers(w(null, null), w(null, null), now)).toBe(true);
    expect(grantCovers(w(null, null), w(h(48), h(72), true), now)).toBe(true);
  });
  it("a timed grant covers only what fits inside it", () => {
    expect(grantCovers(w(null, h(48)), w(null, h(24)), now)).toBe(true);
    expect(grantCovers(w(null, h(2)), w(null, h(24)), now)).toBe(false); // extends it
    expect(grantCovers(w(null, h(48)), w(null, null), now)).toBe(false); // permanent is wider
  });
  it("recurring hours or a later start leave room for another grant", () => {
    expect(grantCovers(w(null, null, true), w(null, h(24)), now)).toBe(false);
    expect(grantCovers(w(h(24), null), w(null, h(2)), now)).toBe(false);
  });
});

describe("grantIsLive", () => {
  const base = { status: "ACTIVE", endsAt: null, requiresApproval: false, approvedAt: null };
  it("only counts grants that can still let someone in", () => {
    expect(grantIsLive(base, now)).toBe(true);
    expect(grantIsLive({ ...base, status: "REVOKED" }, now)).toBe(false);
    expect(grantIsLive({ ...base, endsAt: new Date(h(-1)) }, now)).toBe(false);
    expect(grantIsLive({ ...base, requiresApproval: true }, now)).toBe(false);
  });
});
