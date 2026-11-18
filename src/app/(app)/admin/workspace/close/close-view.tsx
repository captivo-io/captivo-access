"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { buildConnectorCleanupCommand } from "@/lib/connector/repair";

type Counts = { users: number; resources: number; connectors: number; recordings: number };
type State = "ready" | "reauth" | "support";

const RETURN_TO = "/admin/workspace/close";

const ERRORS: Record<string, string> = {
  confirm_mismatch: "Type the workspace address exactly as shown.",
  forbidden: "Only an administrator can close the workspace.",
  support_session: "A Captivo support session can't close a workspace.",
  not_available: "This workspace can't be closed from here.",
};

/**
 * The close page's interactive part: re-authentication when the sign-in is
 * older than ten minutes, the typed confirmation, and the final "closed" state,
 * shown in place because the workspace no longer resolves once it is closed.
 */
export function CloseWorkspaceView({ slug, counts, until, support, state: initial, freshForMs, reauth }: {
  slug: string;
  counts: Counts;
  until: string;
  support: string;
  state: State;
  freshForMs: number;
  reauth: { captivo: boolean; passkey: boolean; sso: boolean };
}) {
  const router = useRouter();
  const [state, setState] = useState<State>(initial);
  const [typed, setTyped] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedUntil, setClosedUntil] = useState<string | null>(null);

  // The ten minutes run out while the page is open: say so before a click fails.
  useEffect(() => {
    if (initial !== "ready") return;
    const t = setTimeout(() => setState((s) => (s === "ready" ? "reauth" : s)), freshForMs);
    return () => clearTimeout(t);
  }, [initial, freshForMs]);

  async function passkeyAgain() {
    setBusy(true);
    setError(null);
    try {
      const o = await fetch("/api/auth/authentication/options", { method: "POST" });
      if (!o.ok) throw new Error();
      const response = await startAuthentication({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/authentication/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response }) });
      if (!v.ok) throw new Error();
      // A new session now carries the cookie; the server decides what it allows.
      router.refresh();
    } catch {
      setError("The passkey could not be verified. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/workspace/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmSlug: typed }) }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string; restorableUntil?: string };
    setBusy(false);
    if (res?.ok && body?.ok) {
      setClosedUntil(body.restorableUntil ? new Date(body.restorableUntil).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : until);
      return;
    }
    if (body?.error === "reauth_required") { setState("reauth"); return; }
    setError(ERRORS[body?.error ?? ""] ?? "Couldn't close the workspace. Try again.");
  }

  if (closedUntil) {
    return (
      <section className="wc-done" role="status">
        <span className="wc-done-ic" aria-hidden="true">✓</span>
        <h2>Workspace closed</h2>
        <p><b>{slug}</b> is offline and every session has ended, this one included. If this workspace sends email, its administrators have been told.</p>
        <p>The data is kept until <b>{closedUntil}</b>. To restore it before then, write to <a href={`mailto:${support}`}>{support}</a>. After that it is removed for good.</p>
        <p>Remember to run the cleanup command on each connector host if you haven&apos;t yet.</p>
        <a className="btn" href="https://captivo.io">Go to captivo.io</a>
      </section>
    );
  }

  const ready = state === "ready";
  return (
    <div className="wc-grid">
      <section className="card">
        <div className="card-head"><h2>What happens</h2></div>
        <ul className="wc-list">
          <li>The console and every app published from this workspace stop at once, for everyone.</li>
          <li>All sessions end, including vendors in the middle of one.</li>
          <li>Connectors can no longer connect. Their containers stay on your hosts until you remove them.</li>
          <li>The data is kept until <b>{until}</b> and can be restored by writing to <a href={`mailto:${support}`}>{support}</a>. After that it is removed permanently.</li>
        </ul>
        <div className="wc-counts">
          <div><b className="mono">{counts.users}</b><span>{counts.users === 1 ? "user" : "users"}</span></div>
          <div><b className="mono">{counts.resources}</b><span>{counts.resources === 1 ? "resource" : "resources"}</span></div>
          <div><b className="mono">{counts.connectors}</b><span>{counts.connectors === 1 ? "connector" : "connectors"}</span></div>
          <div><b className="mono">{counts.recordings}</b><span>{counts.recordings === 1 ? "recording" : "recordings"}</span></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Before you close</h2></div>
        <p className="wc-p"><b>Export the audit log</b> if you need to keep it: nothing can be downloaded once the workspace is closed.</p>
        <div className="row-actions wc-actions">
          <a className="btn sm" href="/api/admin/audit/export">Access log (CSV)</a>
          <a className="btn sm" href="/api/admin/audit/admin-export">Admin actions (CSV)</a>
        </div>
        {counts.connectors > 0 && (
          <>
            <p className="wc-p"><b>Clean up each connector host.</b> Run this on every host that runs a connector. It also deletes the recordings stored there and the only key that opens them.</p>
            <CommandBlock command={buildConnectorCleanupCommand()} title="connector-cleanup" />
          </>
        )}
      </section>

      <section className="card wc-confirm" aria-labelledby="wc-confirm-t">
        <div className="card-head"><h2 id="wc-confirm-t">Close {slug}</h2></div>
        {state === "support" && (
          <p className="notice warn">A Captivo support session can&apos;t close a workspace. An administrator of the workspace has to do it.</p>
        )}
        {state === "reauth" && (
          <div className="wc-reauth">
            <p className="wc-p"><b>Sign in again to continue.</b> Closing a workspace needs a sign-in from the last 10 minutes.</p>
            <div className="row-actions wc-actions">
              {reauth.sso && (
                <a className="btn primary" href={`/api/auth/oidc/start?stepUp=1&returnTo=${encodeURIComponent(RETURN_TO)}`}>
                  {reauth.captivo ? "Sign in again with Captivo" : "Sign in again with SSO"}
                </a>
              )}
              {reauth.passkey && (
                <button type="button" className={reauth.sso ? "btn" : "btn primary"} onClick={() => void passkeyAgain()} disabled={busy}>
                  {busy ? "Waiting for the passkey…" : "Verify with your passkey"}
                </button>
              )}
              {!reauth.sso && !reauth.passkey && <span className="t-muted">Sign out, sign in again and come back to this page.</span>}
            </div>
          </div>
        )}
        {ready && (
          <form className="wc-form" onSubmit={(e) => { e.preventDefault(); void close(); }}>
            <label className="field-label" htmlFor="wc-slug">Type <code>{slug}</code> to confirm</label>
            <input id="wc-slug" className="input mono" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <label className="wc-check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>I understand that everyone loses access now, and that the data is removed for good after {until}.</span>
            </label>
            <div className="row-actions wc-actions">
              <button type="submit" className="btn danger-solid" disabled={busy || !understood || typed !== slug}>{busy ? "Closing…" : "Close workspace"}</button>
            </div>
          </form>
        )}
        {error && <p className="notice error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
