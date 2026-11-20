import { describe, expect, it } from "vitest";
import { backoffMs, chunkByBytes, describeFailure } from "./pump";

describe("pump helpers", () => {
  it("backs off 30 s doubling up to 5 min", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it("chunks by bytes, never splitting a message", () => {
    const lines = ["a".repeat(40), "b".repeat(40), "c".repeat(200)];
    expect(chunkByBytes(lines, 120).map((c) => c.length)).toEqual([2, 1]);
    expect(chunkByBytes([], 10)).toEqual([]);
  });

  it("says what went wrong", () => {
    expect(describeFailure("http_403", "invalid token")).toBe("The endpoint answered HTTP 403: invalid token");
    expect(describeFailure("send_failed", "unreachable: dial tcp 10.0.0.5:514: connect: connection refused")).toContain("connection refused");
    expect(describeFailure("connector_too_old")).toContain("2.42.0");
  });
});
