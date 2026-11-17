"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { startAuthentication, WebAuthnAbortService } from "@simplewebauthn/browser";
import { BrandMark } from "@/components/brand";

const GENERIC_ERROR = "No passkey found, or it could not be verified.";
const CANCELLED = "Sign-in was cancelled. Try again, or sign in with Captivo.";
/** How long "You're in" stays before going on by itself. */
const AUTO_MS = 2000;

type State = "start" | "wait" | "done";
type Me = { account: string | null; workspace: string | null; console: boolean };

/**
 * Sign in, in the design hand-off's three steps: start (passkey, or sign in
 * with Captivo / the workspace's identity provider), waiting for the passkey
 * (cancel goes back with a message), and "You're in" with who, where and how,
 * which goes on to the console or My access after a moment.
 */
export function LoginForm({
  returnTo = "/",
  ssoEnabled = false,
  ssoLabel = "Sign in with SSO",
  ssoIsCaptivo = false,
  ssoError = null,
}: {
  returnTo?: string;
  ssoEnabled?: boolean;
  ssoLabel?: string;
  /** The identity provider is Captivo ID: the button reads "Sign in with Captivo". */
  ssoIsCaptivo?: boolean;
  ssoError?: ReactNode;
}) {
  const [state, setState] = useState<State>("start");
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const cancelled = useRef(false);

  const step = state === "start" ? 1 : state === "wait" ? 2 : 3;
  useEffect(() => {
    const el = document.getElementById("authx-stepno");
    if (el) el.textContent = `Step ${step} / 3`;
  }, [step]);

  // Where to go once signed in: the page asked for, else the console for those
  // who run it and My access for everyone else.
  const next = returnTo && returnTo !== "/" ? returnTo : me?.console === false ? "/access" : "/";
  useEffect(() => {
    if (state !== "done") return;
    const t = setTimeout(() => { window.location.href = next; }, AUTO_MS);
    return () => clearTimeout(t);
  }, [state, next]);

  async function signIn() {
    setError(null);
    cancelled.current = false;
    setState("wait");
    try {
      const optionsRes = await fetch("/api/auth/authentication/options", { method: "POST" });
      const options = await optionsRes.json().catch(() => ({}));
      if (!optionsRes.ok) { setError(GENERIC_ERROR); setState("start"); return; }

      const response = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/authentication/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const result = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !result?.ok) {
        setError(result?.error === "mfa_required"
          ? "Your organization requires two-step verification. Use a passkey that asks for your PIN or fingerprint, or sign in with your identity provider."
          : result?.error === "revoked"
          ? "Your access has been revoked: you are no longer a member of an authorized directory group."
          : GENERIC_ERROR);
        setState("start");
        return;
      }

      try {
        const g = await fetch("/api/access/my-grants");
        const body = (await g.json().catch(() => ({}))) as Partial<Me>;
        setMe({ account: body.account ?? null, workspace: body.workspace ?? null, console: body.console !== false });
      } catch {
        setMe(null);
      }
      setState("done");
    } catch (e) {
      // NotAllowedError: the person dismissed the browser's prompt, or it timed out.
      const aborted = cancelled.current || (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError"));
      setError(aborted ? CANCELLED : GENERIC_ERROR);
      setState("start");
    }
  }

  function cancel() {
    cancelled.current = true;
    WebAuthnAbortService.cancelCeremony();
    setError(CANCELLED);
    setState("start");
  }

  const seg = (i: number) => (state === "done" ? (i === 2 ? "ok" : "on") : i < step ? "on" : "");
  const ssoText = ssoIsCaptivo ? "Sign in with Captivo" : ssoLabel;

  return (
    <>
      <div className="authx-steps" aria-hidden="true"><i className={seg(0)} /><i className={seg(1)} /><i className={seg(2)} /></div>

      {state === "start" && (
        <>
          <h1>Sign in</h1>
          <p className="authx-lead">Sign in securely with your device&apos;s passkey. No password needed.</p>
          {(error || ssoError) && (
            <div className="authx-err" role="alert">
              <span>
                {error ?? ssoError}
                {error && error !== CANCELLED && <> <a href="/recover">Recover your account</a></>}
              </span>
            </div>
          )}
          <div className="auth-actions">
            <button type="button" className="btn btn-passkey" onClick={signIn}>
              <KeyIcon /> Sign in with passkey
            </button>
            {ssoEnabled && (
              <>
                <div className="auth-or"><span>or</span></div>
                <a className="btn btn-captivo" href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`}>
                  {ssoIsCaptivo && <BrandMark size={18} />} {ssoText}
                </a>
              </>
            )}
          </div>
          <p className="authx-help">No passkey? <a href="/recover">Recover access</a> or ask your administrator.</p>
        </>
      )}

      {state === "wait" && (
        <div className="authx-wait" aria-live="polite">
          <div className="authx-ring"><span><FingerprintIcon /></span></div>
          <b>Waiting for your passkey</b>
          <span className="hint">Confirm with your fingerprint, face or security key on this device.</span>
          <button type="button" className="btn" style={{ marginTop: 18 }} onClick={cancel}>Cancel</button>
        </div>
      )}

      {state === "done" && (
        <>
          <div className="authx-done">
            <div className="authx-check" aria-hidden="true">✓</div>
            <h1>You&apos;re in</h1>
            <p className="authx-lead" style={{ margin: 0 }}>Your identity is verified.</p>
          </div>
          <dl className="authx-facts">
            {me?.account && <div><dt>Account</dt><dd>{me.account}</dd></div>}
            {me?.workspace && <div><dt>Workspace</dt><dd className="mono">{me.workspace}</dd></div>}
            <div><dt>Method</dt><dd>Passkey</dd></div>
          </dl>
          <p className="authx-rec"><span className="rec-dot" aria-hidden="true" /> Sessions here may be recorded and audited.</p>
          <a className="btn primary btn-continue" href={next} style={{ ["--auto" as string]: `${AUTO_MS}ms` }}>
            {next === "/" ? "Continue to the console" : next === "/access" ? "Continue to My access" : "Continue"} →
            <span className="bar" aria-hidden="true" />
          </a>
        </>
      )}
    </>
  );
}

function KeyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" />
    </svg>
  );
}
function FingerprintIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 11v3a8 8 0 0 1-1.5 4.7" /><path d="M8.5 12a3.5 3.5 0 0 1 7 0v1.5a12 12 0 0 1-.6 3.8" /><path d="M5.5 15.5A8 8 0 0 1 5 13v-1a7 7 0 0 1 12.5-4.3" /><path d="M19 12v1a15 15 0 0 1-.4 3.5" /><path d="M8 20.5a11 11 0 0 0 1.5-3" />
    </svg>
  );
}
