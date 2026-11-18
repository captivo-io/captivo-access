import { describe, it, expect } from "vitest";
import { formatTotp } from "./recovery-view";

describe("formatTotp", () => {
  it("groups the code as it's typed and drops anything but digits", () => {
    expect(formatTotp("48")).toBe("48");
    expect(formatTotp("4829")).toBe("482 9");
    expect(formatTotp("482913")).toBe("482 913");
    expect(formatTotp("482 913 7")).toBe("482 913");
    expect(formatTotp("4a8-2")).toBe("482");
  });
});
