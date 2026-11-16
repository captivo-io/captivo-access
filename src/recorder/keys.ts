/**
 * Typed-input capture for web app (transparent) sessions -- the page-side half of
 * the keystroke timeline the gateway builds from guac key events.
 *
 * WHAT IS RECORDED: what a field holds once the vendor is done with it (Enter,
 * leaving the field, or a pause), labelled with the field's name, e.g.
 * "Search: invoices 2026". Values rather than raw key codes: a timeline of
 * "Shift, I, n, v..." helps nobody, and the field's own value already has the
 * edits applied.
 *
 * WHAT IS NOT: anything in a credential field. The page knows what a field is,
 * which a keystroke stream on the wire does not, so this is where masking is
 * reliable: password, username, one-time-code and card fields, and fields whose
 * name says they hold a secret, are sent as masked and never with their value.
 * The data-plane drops the text of a masked event again, in case a page lies.
 *
 * Must never break the app: every handler is guarded and does nothing on error.
 */

export interface KeyEvent {
  atMs: number;
  kind: "text";
  text: string;
  masked: boolean;
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

const SECRET_AUTOCOMPLETE = /\b(username|current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)\b/;
const SECRET_NAME = /pass|pwd|pin\b|otp|totp|token|secret|cvv|cvc|card.?num|iban|ssn|tckn/i;
const IGNORED_TYPES = new Set(["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"]);
export const IDLE_MS = 1500;
const MAX_TEXT = 500;

function isTextInput(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && !IGNORED_TYPES.has((el.type || "text").toLowerCase());
}

/** The field the event happened in, or null when it is not one we record. */
export function fieldOf(target: EventTarget | null): Field | null {
  if (!(target instanceof Element)) return null;
  if (isTextInput(target) || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return target;
  const editable = (target as HTMLElement).closest?.("[contenteditable=''],[contenteditable='true'],[contenteditable='plaintext-only']");
  return editable instanceof HTMLElement ? editable : null;
}

/** Whether a field holds a credential (or sits where the login name goes). */
export function isSensitive(el: Field): boolean {
  if (el instanceof HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (type === "password") return true;
    if (SECRET_AUTOCOMPLETE.test((el.getAttribute("autocomplete") || "").toLowerCase())) return true;
    if (SECRET_NAME.test(`${el.name} ${el.id}`)) return true;
    // The login name: a text or e-mail field next to a password -- in the same
    // <form>, or (pages without one) within a few levels up, never the whole
    // page: a search box on a page that also has a login form is not a login.
    if (type === "text" || type === "email" || type === "tel") {
      if (el.form) return !!el.form.querySelector("input[type=password]");
      let scope: Element | null = el.parentElement;
      for (let i = 0; i < 3 && scope && scope.tagName !== "BODY" && scope.tagName !== "HTML"; i++, scope = scope.parentElement) {
        if (scope.querySelector("input[type=password]")) return true;
      }
    }
    return false;
  }
  if (el instanceof HTMLTextAreaElement) return SECRET_NAME.test(`${el.name} ${el.id}`);
  return false;
}

/** A short human label for the field: its <label>, aria-label, placeholder or name. */
export function fieldLabel(el: Field): string {
  const pick = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const ctl = el as HTMLInputElement;
  const fromLabels = ctl.labels && ctl.labels.length ? pick(ctl.labels[0].textContent) : "";
  return fromLabels || pick(el.getAttribute("aria-label")) || pick(el.getAttribute("placeholder")) || pick(el.getAttribute("name")) || pick(el.id);
}

function valueOf(el: Field): string {
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.text ?? el.value;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.innerText ?? el.textContent ?? "";
}

export function installKeyCapture(opts: {
  start: number;
  emit: (e: KeyEvent) => void;
  now?: () => number;
  doc?: Document;
}): { flush: () => void; stop: () => void } {
  const now = opts.now ?? (() => Date.now());
  const doc = opts.doc ?? document;
  let current: Field | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const last = new WeakMap<Field, string>();

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const el = current;
    if (!el) return;
    try {
      const value = valueOf(el);
      if (last.get(el) === value) return;
      last.set(el, value);
      if (!value) return;
      const masked = isSensitive(el);
      const label = fieldLabel(el);
      const text = masked ? "••••" : (label ? `${label}: ` : "") + value.slice(0, MAX_TEXT);
      opts.emit({ atMs: Math.max(0, now() - opts.start), kind: "text", text, masked });
    } catch { /* never break the app */ }
  };

  const target = (e: Event) => fieldOf((e.composedPath?.()[0] as EventTarget) ?? e.target);

  const onInput = (e: Event) => {
    try {
      const el = target(e);
      if (!el) return;
      if (current && current !== el) flush();
      current = el;
      if (el instanceof HTMLSelectElement) { flush(); return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, IDLE_MS);
    } catch { /* ignore */ }
  };
  const onKey = (e: KeyboardEvent) => {
    try {
      if (e.key === "Enter" && current && target(e) === current) flush();
    } catch { /* ignore */ }
  };
  const onLeave = (e: Event) => {
    try {
      if (current && target(e) === current) { flush(); current = null; }
    } catch { /* ignore */ }
  };

  doc.addEventListener("input", onInput, true);
  doc.addEventListener("change", onInput, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("focusout", onLeave, true);
  return {
    // Emit what the current field holds now (the page is being hidden), and
    // keep listening: a page restored from the back-forward cache goes on.
    flush,
    stop: () => {
      flush();
      doc.removeEventListener("input", onInput, true);
      doc.removeEventListener("change", onInput, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("focusout", onLeave, true);
    },
  };
}
