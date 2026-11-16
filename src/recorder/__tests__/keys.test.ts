// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installKeyCapture, isSensitive, IDLE_MS, type KeyEvent } from "../keys";

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("web app typed-input capture", () => {
  let events: KeyEvent[];
  let clock: number;
  let capture: { flush: () => void; stop: () => void };

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    clock = 10_000;
    capture = installKeyCapture({ start: 10_000, emit: (e) => events.push(e), now: () => clock });
  });
  afterEach(() => {
    capture.stop();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("records a field's value, labelled, on Enter, at its offset from the recording start", () => {
    document.body.innerHTML = `<label for="q">Search</label><input id="q" name="q">`;
    const q = document.getElementById("q") as HTMLInputElement;
    clock = 12_500;
    type(q, "invoices 2026");
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(events).toEqual([{ atMs: 2_500, kind: "text", text: "Search: invoices 2026", masked: false }]);
  });

  it("also emits after a pause and when the field is left, once per value", () => {
    document.body.innerHTML = `<textarea aria-label="Note"></textarea><input placeholder="City">`;
    const note = document.querySelector("textarea")!;
    type(note, "first draft");
    vi.advanceTimersByTime(IDLE_MS + 10);
    note.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(events.map((e) => e.text)).toEqual(["Note: first draft"]);
  });

  it("never sends what is typed into a password, login-name or one-time-code field", () => {
    document.body.innerHTML = `<form><input id="u" type="email" placeholder="E-mail"><input id="p" type="password"></form>
      <input id="otp" autocomplete="one-time-code"><input id="pin" name="pin_code">`;
    for (const [id, v] of [["u", "vendor@acme.test"], ["p", "hunter2"], ["otp", "123456"], ["pin", "9876"]]) {
      const el = document.getElementById(id) as HTMLInputElement;
      type(el, v);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.masked && e.text === "••••")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/vendor@acme|hunter2|123456|9876/);
  });

  it("a plain e-mail field outside a login form is not masked", () => {
    document.body.innerHTML = `<div><input type="email" aria-label="Notify"></div>`;
    expect(isSensitive(document.querySelector("input")!)).toBe(false);
  });

  it("a search box on the same page as a login form is recorded (found live in the isolated browser)", () => {
    document.body.innerHTML = `<form><input type="email"><input type="password"></form><label for="q">Search</label><input id="q" name="q">`;
    expect(isSensitive(document.getElementById("q") as HTMLInputElement)).toBe(false);
    // A login with no <form> element is still caught, a few levels up.
    document.body.innerHTML = `<div class="login"><div><input id="u" type="text"></div><div><input type="password"></div></div>`;
    expect(isSensitive(document.getElementById("u") as HTMLInputElement)).toBe(true);
  });
});
