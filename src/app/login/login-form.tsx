"use client";

import { useState, type ReactNode } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { launchHref } from "@/lib/portal/launch-href";

const GENERIC_ERROR = "No passkey found or verification failed.";

type Grant = { id: string; siteId: string; hostname: string; siteName: string; accessMode: "TRANSPARENT" | "GATEWAY" | "ISOLATED"; endsAt: string | null; scheduled: boolean };
type State = "rest" | "ceremony" | "ready";

export function LoginForm({
  returnTo = "/",
  ssoEnabled = false,
  ssoLabel = "Sign in with SSO",
  ssoError = null,
}: {
  returnTo?: string;
  ssoEnabled?: boolean;
  ssoLabel?: string;
  ssoError?: ReactNode;
}) {
  const [state, setState] = useState<State>("rest");
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);

  async function signIn() {
    setError(null);
    setState("ceremony");
    try {
      const optionsRes = await fetch("/api/auth/authentication/options", { method: "POST" });
      const options = await optionsRes.json().catch(() => ({}));
      if (!optionsRes.ok) { setError(GENERIC_ERROR); setState("rest"); return; }

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
          ? "Your access has been revoked — you are no longer a member of an authorized directory group."
          : GENERIC_ERROR);
        setState("rest");
        return;
      }

      // Signed in — fetch active grants for the access-ready step (best-effort).
      try {
        const g = await fetch("/api/access/my-grants");
        const body = (await g.json().catch(() => ({}))) as { grants?: Grant[] };
        setGrants(Array.isArray(body.grants) ? body.grants : []);
      } catch { setGrants([]); }
      setState("ready");
    } catch {
      setError(GENERIC_ERROR);
      setState("rest");
    }
  }

  const seg = (i: number) => (i <= (state === "rest" ? 0 : state === "ceremony" ? 1 : 2) ? "on" : "");

  return (
    <>
      <div className="authx-steps" aria-hidden="true"><i className={seg(0)} /><i className={seg(1)} /><i className={seg(2)} /></div>

      {state === "rest" && (
        <>
          <h1>Sign in</h1>
          <p>Use your device&apos;s passkey — no password.</p>
          {ssoError && <p className="notice error" role="alert">{ssoError}</p>}
          {error && <p className="notice error" role="alert">{error} <a href="/recover">Recover your account</a></p>}
          <div className="auth-actions">
            <button type="button" className="btn primary" onClick={signIn}>Sign in with passkey</button>
            {ssoEnabled && (
              <>
                <div className="auth-or"><span>or</span></div>
                <a className="btn" href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`}>{ssoLabel}</a>
              </>
            )}
          </div>
        </>
      )}

      {state === "ceremony" && (
        <>
          <h1>Verify with passkey</h1>
          <p>Confirm on your device to continue.</p>
          <div className="authx-zone">
            <div className="authx-ring"><div className="authx-spin" /></div>
            <div>Waiting for your passkey…</div>
          </div>
          <div className="auth-actions" style={{ marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={signIn}>Use a different device</button>
          </div>
        </>
      )}

      {state === "ready" && (
        <>
          <div className="authx-check" aria-hidden="true">✓</div>
          <h1>You&apos;re in</h1>
          <p>{grants.length > 0 ? "You have access to:" : "You're signed in."}</p>
          {grants.length > 0 ? (
            <div className="authx-grants">
              {grants.map((g) => (
                <a key={g.id} className="authx-grant" href={launchHref(g.accessMode, g.siteId, g.hostname)}>
                  <span className="chip">{g.accessMode === "GATEWAY" ? "REMOTE" : "WEB"}</span>
                  <span className="nm">{g.siteName}</span>
                  <span className="win">{g.scheduled ? "scheduled" : g.endsAt ? <LocalTime iso={g.endsAt} /> : "permanent"}</span>
                  <span className="go" aria-hidden="true">↗</span>
                </a>
              ))}
            </div>
          ) : (
            <div className="authx-empty">No active grants yet — an admin can grant you access.</div>
          )}
          <div className="auth-actions">
            <a className="btn primary" href={returnTo}>Go to my access</a>
          </div>
        </>
      )}
    </>
  );
}
