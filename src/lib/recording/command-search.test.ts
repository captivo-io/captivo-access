import { describe, it, expect } from "vitest";
import { commandTextMatches } from "./command-search";

/**
 * The substring rule itself. The scan that used this moved to the connector
 * (connector/recsearch.go) with the keystroke text; this module is now the written
 * reference for that copy, and these tests are what keep the two honest.
 *
 * Masking and format selection are asserted on the connector side, where the data
 * is -- see connector/recsearch_test.go, which fails with the password in the
 * message when the mask check is removed.
 */
describe("commandTextMatches", () => {
  it("matches case-insensitively", () => {
    expect(commandTextMatches("sudo RM -RF /tmp", "rm -rf")).toBe(true);
    expect(commandTextMatches("sudo rm -rf /tmp", "RM -RF")).toBe(true);
  });

  it("never matches an empty query", () => {
    // An empty needle would otherwise match every recording.
    expect(commandTextMatches("anything at all", "")).toBe(false);
  });

  it("does not match text that is absent", () => {
    expect(commandTextMatches("ls -la", "rm -rf")).toBe(false);
  });
});
