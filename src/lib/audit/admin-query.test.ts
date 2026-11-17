import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { buildAdminAuditWhere, parseAdminFilter } from "./admin-query";

describe("buildAdminAuditWhere", () => {
  it("is empty without filters", () => {
    expect(buildAdminAuditWhere({})).toEqual({});
  });
  it("turns a category into action prefixes and ANDs the search", () => {
    const w = buildAdminAuditWhere({ category: "recording", q: " erasure " });
    expect(w.AND).toEqual([
      { OR: [{ action: { startsWith: "recording." } }] },
      { OR: expect.arrayContaining([{ summary: { contains: "erasure", mode: "insensitive" } }, { targetId: { contains: "erasure" } }]) },
    ]);
  });
});

describe("parseAdminFilter", () => {
  it("drops unknown categories and clamps the limit", () => {
    expect(parseAdminFilter(new URLSearchParams("category=toString&limit=999&offset=-3"), 100, 200)).toEqual({ q: undefined, category: undefined, limit: 200, offset: 0 });
    expect(parseAdminFilter(new URLSearchParams("category=connector&q=x"), 100, 200)).toMatchObject({ category: "connector", q: "x", limit: 100 });
  });
});
