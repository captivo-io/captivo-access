// Which key chord makes the REMOTE side paste guacd's clipboard, per protocol.
// guacd's terminal (SSH/telnet) pastes on Ctrl+Shift+V (plain Ctrl+V is sent to
// the shell as ^V); RDP/VNC desktops paste on Ctrl+V. Returned as X11 keysyms in
// press order (released in reverse). `ctrlHeld` = the user is already holding
// Ctrl (its keydown was forwarded), so the chord must not press it again.
export const KEYSYM = { ctrlL: 0xffe3, ctrlR: 0xffe4, shiftL: 0xffe1, shiftR: 0xffe2, altL: 0xffe9, altR: 0xffea, insert: 0xff63, v: 0x76, V: 0x56 } as const;

export type GatewayProtocol = "RDP" | "SSH" | "VNC";

export function pasteKeySequence(protocol: GatewayProtocol, ctrlHeld: boolean): number[] {
  const chord = protocol === "SSH" ? [KEYSYM.shiftL, KEYSYM.V] : [KEYSYM.v];
  return ctrlHeld ? chord : [KEYSYM.ctrlL, ...chord];
}

// Ctrl+V (no Shift/Alt) is the browser paste gesture: the session swallows the
// `v` key so the browser fires `paste` (clipboard text with no permission prompt),
// pushes that text to guacd, then replays the protocol's paste chord.
export function isBrowserPasteKey(keysym: number, mods: { ctrl: boolean; alt: boolean }): boolean {
  return keysym === KEYSYM.v && mods.ctrl && !mods.alt;
}
