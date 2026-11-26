"use client";

import { useState } from "react";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";
import { TimezoneHint } from "@/app/(app)/_shell/effective-timezone";
import { formatDatetimeLocal, parseDatetimeLocal } from "@/lib/time/datetime-local";
import { CheckoutField } from "./checkout-field";

// ISO → value for <input type="datetime-local"> in the display timezone (or the
// browser's when none is configured) — the same zone the grant list shows.
function toLocalInput(iso: string | null, tz: string | null): string {
  if (!iso) return "";
  return formatDatetimeLocal(new Date(iso), tz);
}

function saveError(code: string | undefined): string {
  switch (code) {
    case "ends_at_in_past": return "The end date must be in the future.";
    case "ends_at_before_start": return "The end date must be after the start date.";
    case "invalid_ends_at": return "Enter a valid end date.";
    case "grant_requires_end": return "Policy requires an end date — permanent grants aren't allowed here.";
    case "grant_exceeds_max": return "This grant is longer than the maximum duration allowed by policy.";
    case "note_too_long": return "The note is too long (max 500 characters).";
    case "invalid_note": return "The note must be text.";
    case "not_active": return "This grant is no longer active and can't be edited.";
    case "invalid_checkout_minutes": return "Pick one of the check-out lengths.";
    case "nothing_to_update": return "Nothing to save.";
    case "forbidden": return "Admin privileges are required.";
    default: return "Couldn't save, please try again.";
  }
}

/** The end date, note and password access of a grant: what an edit can change. `checkout` is null for a resource without check-out. */
export function EditGrantBody({ id, endsAt, note, checkout, onDone, onClose }: {
  id: string; endsAt: string | null; note: string | null; checkout?: { on: boolean; minutes: number | null; name: string } | null; onDone: () => void; onClose: () => void;
}) {
  const tz = useTimezone();
  // Mounted only on the client (inside the open dialog), so the browser-zone
  // fallback never runs during SSR.
  const [endsAtLocal, setEndsAtLocal] = useState(() => toLocalInput(endsAt, tz));
  const [noteValue, setNoteValue] = useState(note ?? "");
  const [pwd, setPwd] = useState(checkout?.on ?? false);
  const [pwdMinutes, setPwdMinutes] = useState(checkout?.minutes != null ? String(checkout.minutes) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const payload: { endsAt?: string; note: string; passwordCheckout?: boolean; checkoutMinutes?: number | null } = { note: noteValue };
    if (checkout) { payload.passwordCheckout = pwd; payload.checkoutMinutes = pwd && pwdMinutes ? Number(pwdMinutes) : null; }
    if (endsAtLocal) {
      const d = parseDatetimeLocal(endsAtLocal, tz);
      if (!d) { setError("Enter a valid end date."); return; }
      payload.endsAt = d.toISOString();
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/grants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.ok) { setError(saveError(result?.error)); return; }
      onDone();
    } catch {
      setError("Couldn't save, please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rq" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="rq-sec">
        <span className="rq-label"><span>End date<TimezoneHint /></span>{!endsAt && <span className="mono t-muted">now permanent</span>}</span>
        <input className="input" type="datetime-local" value={endsAtLocal} onChange={(e) => setEndsAtLocal(e.target.value)} />
      </label>
      <label className="rq-sec">
        <span className="rq-label"><span>Note</span></span>
        <input className="input" type="text" value={noteValue} maxLength={500} onChange={(e) => setNoteValue(e.target.value)} />
      </label>
      {checkout && <CheckoutField on={pwd} minutes={pwdMinutes} onOn={setPwd} onMinutes={setPwdMinutes} names={[checkout.name]} />}
      <p className="rq-hint">To change the resource or the recurring hours, revoke this grant and give a new one.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="rq-foot">
        <span className="rq-status" />
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
