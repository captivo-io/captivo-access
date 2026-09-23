import { describe, it, expect } from "vitest";
import { pasteKeySequence, isBrowserPasteKey, KEYSYM } from "./paste-keys";

describe("pasteKeySequence", () => {
  it("SSH pastes with Ctrl+Shift+V, desktops with Ctrl+V", () => {
    expect(pasteKeySequence("SSH", false)).toEqual([KEYSYM.ctrlL, KEYSYM.shiftL, KEYSYM.V]);
    expect(pasteKeySequence("RDP", false)).toEqual([KEYSYM.ctrlL, KEYSYM.v]);
    expect(pasteKeySequence("VNC", false)).toEqual([KEYSYM.ctrlL, KEYSYM.v]);
  });
  it("does not press Ctrl again when the user already holds it", () => {
    expect(pasteKeySequence("SSH", true)).toEqual([KEYSYM.shiftL, KEYSYM.V]);
    expect(pasteKeySequence("RDP", true)).toEqual([KEYSYM.v]);
  });
});

describe("isBrowserPasteKey", () => {
  it("matches Ctrl+v only (not Ctrl+Shift+V, not Ctrl+Alt+v, not plain v)", () => {
    expect(isBrowserPasteKey(KEYSYM.v, { ctrl: true, alt: false })).toBe(true);
    expect(isBrowserPasteKey(KEYSYM.V, { ctrl: true, alt: false })).toBe(false);
    expect(isBrowserPasteKey(KEYSYM.v, { ctrl: true, alt: true })).toBe(false);
    expect(isBrowserPasteKey(KEYSYM.v, { ctrl: false, alt: false })).toBe(false);
  });
});
