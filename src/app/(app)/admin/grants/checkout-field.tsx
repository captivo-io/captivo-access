"use client";

/** How long one password check-out lasts, as the grant dialogs offer it. Empty: the resource's own limit. */
export const CHECKOUT_LENGTHS: { value: string; label: string }[] = [
  { value: "", label: "The resource's limit" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "480", label: "8 hours" },
  { value: "1440", label: "24 hours" },
];

/**
 * "May see the password": a person with this grant can check the saved password out
 * (lib/vault/checkout.ts), for a while, and it is changed afterwards where the resource
 * can rotate it. Shown only for resources that have check-out turned on; off unless ticked.
 */
export function CheckoutField({ on, minutes, onOn, onMinutes, names }: {
  on: boolean; minutes: string; onOn: (v: boolean) => void; onMinutes: (v: string) => void; names: string[];
}) {
  return (
    <div className="rq-sec">
      <label className="rf-keep-check">
        <input type="checkbox" checked={on} onChange={(e) => onOn(e.target.checked)} />
        <span>May see the password</span>
      </label>
      <p className="rq-hint">
        {names.join(", ")} {names.length === 1 ? "has" : "have"} password check-out on. With this ticked the person can take the saved
        password for a while, in the audit log, and it is changed again afterwards where the resource can rotate it. Off unless you tick it.
      </p>
      {on && (
        <label className="rq-sec">
          <span className="rq-label"><span>For how long</span></span>
          <select className="input" value={minutes} onChange={(e) => onMinutes(e.target.value)}>
            {CHECKOUT_LENGTHS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
