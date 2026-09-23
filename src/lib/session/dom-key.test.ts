import { describe, it, expect } from "vitest";
import { keysymToDomKey } from "./dom-key";
import { KEY, charKeysym } from "./keysyms";

describe("keysymToDomKey", () => {
  it("maps letters with shift state, digits and punctuation to key+code", () => {
    expect(keysymToDomKey(charKeysym("a"))).toEqual({ key: "a", code: "KeyA", keyCode: 65 });
    expect(keysymToDomKey(charKeysym("a"), true)).toEqual({ key: "A", code: "KeyA", keyCode: 65 });
    expect(keysymToDomKey(charKeysym("7"))).toEqual({ key: "7", code: "Digit7", keyCode: 55 });
    expect(keysymToDomKey(charKeysym("/"))).toEqual({ key: "/", code: "Slash", keyCode: 191 });
    expect(keysymToDomKey(charKeysym("?"))).toEqual({ key: "?", code: "Slash", keyCode: 191 });
    expect(keysymToDomKey(charKeysym(" "))).toEqual({ key: " ", code: "Space", keyCode: 32 });
  });
  it("maps specials, modifiers and function keys", () => {
    expect(keysymToDomKey(KEY.enter)).toEqual({ key: "Enter", code: "Enter", keyCode: 13 });
    expect(keysymToDomKey(KEY.ctrl)).toEqual({ key: "Control", code: "ControlLeft", keyCode: 17 });
    expect(keysymToDomKey(KEY.left)?.code).toBe("ArrowLeft");
    expect(keysymToDomKey(KEY.f5)).toEqual({ key: "F5", code: "F5", keyCode: 116 });
    expect(keysymToDomKey(KEY.f12)?.code).toBe("F12");
  });
  it("returns null for unknown keysyms", () => {
    expect(keysymToDomKey(0xff00)).toBeNull();
  });
});
