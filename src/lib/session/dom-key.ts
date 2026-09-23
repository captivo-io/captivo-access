// X11 keysym → DOM KeyboardEvent init (key / code / keyCode). Used to drive a
// noVNC/KasmVNC client we cannot reach programmatically: its Keyboard listens on
// a hidden input and matches keydown/keyup by `code`, so a synthetic event needs
// BOTH `key` and `code` (and both edges) to register. Pure — unit-tested.
import { KEY } from "./keysyms";

export interface DomKeyInit { key: string; code: string; keyCode: number }

const PUNCT: Record<string, [string, number]> = {
  "`": ["Backquote", 192], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191],
  " ": ["Space", 32],
};
// Shifted punctuation on a US layout → the unshifted physical key.
const SHIFTED: Record<string, string> = { "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/" };

const SPECIAL: Record<number, DomKeyInit> = {
  [KEY.esc]: { key: "Escape", code: "Escape", keyCode: 27 },
  [KEY.tab]: { key: "Tab", code: "Tab", keyCode: 9 },
  [KEY.backspace]: { key: "Backspace", code: "Backspace", keyCode: 8 },
  [KEY.enter]: { key: "Enter", code: "Enter", keyCode: 13 },
  [KEY.caps]: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  [KEY.shift]: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  [KEY.ctrl]: { key: "Control", code: "ControlLeft", keyCode: 17 },
  [KEY.alt]: { key: "Alt", code: "AltLeft", keyCode: 18 },
  [KEY.super]: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  [KEY.menu]: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
  [KEY.del]: { key: "Delete", code: "Delete", keyCode: 46 },
  [KEY.ins]: { key: "Insert", code: "Insert", keyCode: 45 },
  [KEY.home]: { key: "Home", code: "Home", keyCode: 36 },
  [KEY.end]: { key: "End", code: "End", keyCode: 35 },
  [KEY.pgup]: { key: "PageUp", code: "PageUp", keyCode: 33 },
  [KEY.pgdn]: { key: "PageDown", code: "PageDown", keyCode: 34 },
  [KEY.left]: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  [KEY.up]: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  [KEY.right]: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  [KEY.down]: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
};
for (let i = 1; i <= 12; i++) SPECIAL[0xffbe + i - 1] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

export function keysymToDomKey(keysym: number, shift = false): DomKeyInit | null {
  const sp = SPECIAL[keysym];
  if (sp) return sp;
  if (keysym < 0x20 || keysym > 0x7e) return null;
  const ch = String.fromCharCode(keysym);
  if (/[a-z]/.test(ch)) return { key: shift ? ch.toUpperCase() : ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/[A-Z]/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0) };
  if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
  const base = SHIFTED[ch] ?? ch;
  const p = PUNCT[base];
  if (!p) return null;
  return { key: ch, code: p[0], keyCode: p[1] };
}
