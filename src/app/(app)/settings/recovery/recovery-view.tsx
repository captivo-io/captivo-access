"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { AccountHead } from "../account-head";

const ERRORS: Record<string, string> = {
  invalid_code: "That code isn't right. Check the app and try the current code.",
  invalid_body: "Enter the 6-digit code.",
  unauthorized: "Your session has expired, please sign in again.",
};

/** "482913" → "482 913", as the design shows the code while it's typed. */
export function formatTotp(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 6);
  return d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
}

const STEPS = [
  ["Connect the app", "Scan the QR code with your authenticator."],
  ["Verify the code", "Enter the 6-digit code from the app."],
] as const;

/**
 * Recovery tab of My account (design hand-off 11, 7.24): an authenticator app
 * (TOTP) as the way back in when every passkey is lost. Two steps — connect,
 * verify; the hand-off's third step (backup codes) is left out by decision:
 * an admin's passkey reset link covers losing both.
 */
export function RecoveryView({ workspace, setUpAt }: { workspace: string | null; setUpAt: string | null }) {
  const router = useRouter();
  const on = setUpAt !== null;
  const [flow, setFlow] = useState<null | { step: 1 | 2; secret: string; qr: string | null }>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const digits = code.replace(/\D/g, "");

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/recovery/start", { method: "POST" });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || !r?.secret) { setError(ERRORS[r?.error] ?? "Couldn't start recovery setup, please try again."); return; }
      setCode("");
      setFlow({ step: 1, secret: r.secret, qr: typeof r.qr === "string" ? r.qr : null });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!flow || digits.length !== 6) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: digits, secret: flow.secret }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || !r?.ok) { setError(ERRORS[r?.error] ?? "Couldn't turn on recovery, please try again."); return; }
      setFlow(null);
      setToast("Recovery turned on");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recovery", { method: "DELETE" });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || !r?.ok) { setError("Couldn't remove recovery, please try again."); return; }
      setConfirmRemove(false);
      setToast("Recovery removed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!flow) return;
    try { await navigator.clipboard.writeText(flow.secret); setToast("Copied"); } catch { /* the key stays visible to copy by hand */ }
  }

  const spaced = flow ? flow.secret.replace(/(.{4})/g, "$1 ").trim() : "";

  return (
    <div className="ac">
      <AccountHead tab="recovery" title="Recovery" workspace={workspace} recoveryOn={on} sub="Your way back in if you lose all your passkeys." />
      {error && <p className="notice error" role="alert">{error}</p>}

      {!on && !flow && (
        <section className="ac-rc-off">
          <div className="ac-rc-pitch">
            <span className="ac-pill warn"><span />Not set up</span>
            <b>Authenticator app</b>
            <p>Add Google Authenticator, 1Password or a similar app. If you can&apos;t reach your devices, sign in with a code from the app and add a new passkey.</p>
            <span><button type="button" className="btn primary" onClick={() => void start()} disabled={busy}>{busy ? "Preparing…" : "Set up recovery"}</button></span>
          </div>
          <ol className="ac-steps">
            {STEPS.map(([t, s], i) => (
              <li key={t}><span className="ac-step-n">{i + 1}</span><span><b>{t}</b><span>{s}</span></span></li>
            ))}
            <li className="muted"><span className="ac-step-n"><NavIcon name="users" size={12} /></span><span><b>Lost the app too?</b><span>An admin of this workspace can send you a link to make a new passkey.</span></span></li>
          </ol>
        </section>
      )}

      {flow && (
        <section className="ac-flow">
          <div className="ac-prog">
            {["Connect", "Verify"].map((t, i) => {
              const n = i + 1;
              const state = n < flow.step ? "done" : n === flow.step ? "now" : "next";
              return (
                <div key={t} className={`ac-prog-s ${state}`}>
                  <span className="ac-prog-m"><span>{state === "done" ? "✓" : n}</span>{n < 2 && <i />}</span>
                  <b>{t}</b>
                </div>
              );
            })}
          </div>
          {flow.step === 1 ? (
            <div className="ac-flow-b ac-scan">
              {flow.qr ? (
                // eslint-disable-next-line @next/next/no-img-element -- inline data URL, not an optimizable asset
                <img className="ac-qr" src={flow.qr} alt="QR code for your authenticator app" width={176} height={176} />
              ) : null}
              <div className="ac-scan-t">
                <b>Scan the QR code</b>
                <span className="cell-sub">In your authenticator app choose &ldquo;Add account&rdquo; and scan this code.</span>
                <span className="cell-sub">Can&apos;t scan? Enter this key manually:</span>
                <span className="ac-key"><code>{spaced}</code><button type="button" className="btn sm" onClick={() => void copyKey()}>Copy</button></span>
              </div>
            </div>
          ) : (
            <form className="ac-flow-b ac-code" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
              <b>Enter the code from the app</b>
              <span className="cell-sub">The code refreshes every 30 seconds.</span>
              <input className={digits.length === 6 ? "ac-code-in ok" : "ac-code-in"} value={formatTotp(code)} onChange={(e) => setCode(e.target.value)}
                inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000 000" aria-label="Code from the app" autoFocus />
              <span className={digits.length === 6 ? "ac-code-h ok" : "ac-code-h"}>{digits.length === 6 ? "✓ 6 digits" : "Enter 6 digits."}</span>
            </form>
          )}
          <footer className="ac-flow-f">
            <button type="button" className="btn" onClick={() => (flow.step === 1 ? setFlow(null) : setFlow({ ...flow, step: 1 }))}>{flow.step === 1 ? "Cancel" : "Back"}</button>
            {flow.step === 1
              ? <button type="button" className="btn primary" onClick={() => setFlow({ ...flow, step: 2 })}>Continue</button>
              : <button type="button" className="btn primary" disabled={busy || digits.length !== 6} onClick={() => void verify()}>{busy ? "Verifying…" : "Verify and turn on"}</button>}
          </footer>
        </section>
      )}

      {on && (
        <section className="ac-rc-on">
          <div className="ac-rc-on-h">
            <span className="ac-pk-ic ok"><NavIcon name="shield" size={20} /></span>
            <span className="ac-rc-on-t"><b>Recovery is on</b><span>If you can&apos;t reach your passkeys, sign in with a code from your authenticator app and add a new passkey.</span></span>
            <span className="ac-pill ok"><span />On</span>
          </div>
          <div className="ac-kv">
            <div><span>METHOD</span><b>Authenticator app (TOTP)</b></div>
            <div><span>SET UP</span><b><LocalTime iso={setUpAt} mode="shortdate" /></b></div>
          </div>
          <div className="ac-rc-on-f">
            <button type="button" className={confirmRemove ? "btn sm danger solid" : "btn sm danger"} disabled={busy}
              onClick={() => void remove()} onBlur={() => setConfirmRemove(false)}>{confirmRemove ? "Sure? Remove" : "Remove recovery"}</button>
          </div>
        </section>
      )}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}
