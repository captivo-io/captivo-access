"use client";
import { useState } from "react";
import { KEYBOARD_ROWS, type KeyDef } from "@/lib/session/keysyms";
import { applyKey, EMPTY_MODS, type ModState } from "@/lib/session/modifiers";
import { useEdgeDrag } from "./shell/edge-drag";

export function OnScreenKeyboard({ sendKey }: { sendKey: (keysym: number, pressed: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [mods, setMods] = useState<ModState>(EMPTY_MODS);
  const { attach: handleRef, style: handleStyle, handlers: handleEvents } = useEdgeDrag("captivo.session.keyboard-top");

  const press = (k: KeyDef) => {
    const { events, next } = applyKey(mods, k);
    for (const e of events) sendKey(e.keysym, e.pressed);
    setMods(next);
  };
  const armed = (k: KeyDef) => k.modifier && mods[k.modifier];

  return (
    <>
      <button type="button" ref={handleRef} style={handleStyle} {...handleEvents} title="Keyboard · drag to move" onClick={() => setOpen((v) => !v)} className="osk-handle" aria-label="On-screen keyboard">⌨</button>
      {open && (
        <div className="osk" role="group" aria-label="On-screen keyboard">
          <button type="button" className="osk-close" onClick={() => setOpen(false)} aria-label="Close keyboard">✕</button>
          {KEYBOARD_ROWS.map((r, i) => (
            <div key={i} className="osk-row">
              {r.map((k, j) => (
                <button key={j} type="button" className={"osk-key" + (armed(k) ? " armed" : "")} style={{ flexGrow: k.width ?? 1 }} onClick={() => press(k)}>
                  {k.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
