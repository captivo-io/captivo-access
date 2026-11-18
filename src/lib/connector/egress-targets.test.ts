import { describe, it, expect } from "vitest";
import { classifyTarget, parseTargets } from "./egress-targets";

describe("connector egress targets", () => {
  it("classifies what the connector accepts", () => {
    expect(classifyTarget("10.0.5.0/24")).toBe("cidr");
    expect(classifyTarget("fd00::/8")).toBe("cidr");
    expect(classifyTarget("db.internal:5432")).toBe("hp");
    expect(classifyTarget("10.0.0.3:3389")).toBe("hp");
    expect(classifyTarget("[fd00::1]:22")).toBe("hp");
    expect(classifyTarget("db.internal")).toBe("host");
    expect(classifyTarget("10.0.0.3")).toBe("ip");
    expect(classifyTarget("fe80::1")).toBe("ip");
  });
  it("refuses what the connector would reject or never match", () => {
    for (const v of ["10.0.0.300", "10.0.5.0/33", "10.0.5/24", "db.internal:0", "db.internal:70000", "*.corp", "a:b:c", "host/x", "10.0.0.1/24/1", "db:port"]) {
      expect(classifyTarget(v), v).toBeNull();
    }
  });
  it("splits on commas, spaces and new lines and saves comma-separated", () => {
    const r = parseTargets("10.0.5.0/24 db.internal:5432,\n10.0.0.300");
    expect(r.targets.map((t) => t.kind)).toEqual(["cidr", "hp", null]);
    expect(r.invalid).toEqual(["10.0.0.300"]);
    expect(r.normalized).toBe("10.0.5.0/24, db.internal:5432, 10.0.0.300");
    expect(parseTargets("  ").targets).toEqual([]);
  });
});
