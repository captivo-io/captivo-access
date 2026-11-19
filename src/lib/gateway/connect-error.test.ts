import { describe, it, expect } from "vitest";
import { sessionFailure } from "./connect-error";

describe("sessionFailure", () => {
  it("names a refused RDP sign-in and keeps guacd's text as the detail", () => {
    const f = sessionFailure({ code: 0x0301, message: "Authentication failure (invalid credentials?)" });
    expect(f.title).toBe("The computer rejected the sign-in");
    expect(f.hint).toContain("DOMAIN\\user");
    expect(f.detail).toBe("Authentication failure (invalid credentials?)");
  });

  it("says the target could not be reached for upstream errors", () => {
    for (const code of [0x0203, 0x0207, 0x0208]) expect(sessionFailure({ code }).title).toBe("The computer could not be reached");
  });

  it("falls back to the generic message without a status", () => {
    expect(sessionFailure(undefined)).toEqual({
      title: "The session ended or could not start",
      hint: "Try again. If it keeps happening, ask an administrator of this workspace to check the resource.",
      detail: null,
    });
    expect(sessionFailure({ code: 0x0200, message: "  " }).detail).toBeNull();
  });
});
