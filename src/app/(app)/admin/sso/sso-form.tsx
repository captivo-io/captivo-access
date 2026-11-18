"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PROVIDERS, providerByKey, providerFromIssuer, ssoChip, type ProviderKey } from "./providers";
import type { TestResult, StepKey } from "@/app/api/admin/sso/test/steps";

type Initial = {
  exists: boolean; enabled: boolean; issuer: string; clientId: string;
  buttonLabel: string; hasSecret: boolean; lastTestOk: boolean;
};

const STEP_LABELS: Record<StepKey, string> = {
  discovery: "Discovery document (.well-known)",
  jwks: "Signing keys (JWKS)",
  client: "Client ID and secret saved",
};
const STEP_ORDER: StepKey[] = ["discovery", "jwks", "client"];
const STEP_MS = 550;

const SAVE_ERRORS: Record<string, string> = {
  issuer_client_required: "Issuer URL and Client ID are required.",
  secret_required: "Add the client secret before switching SSO on.",
  captivo_id_issuer: "That is Captivo's own sign-in, which is already used when no provider is set here.",
  test_required: "Test the connection first. SSO can go on once the test passes.",
};
const TEST_ERRORS: Record<string, string> = {
  no_issuer: "Save an issuer URL first.",
  unreachable: "Couldn't read the discovery document. Check the issuer URL.",
  jwks_failed: "The provider's signing keys couldn't be read.",
  credentials_missing: "Save the client ID and client secret, then test again.",
};

const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

export function SsoForm({ initial, redirectUri, captivoId }: { initial: Initial; redirectUri: string; captivoId: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [provider, setProvider] = useState<ProviderKey>(initial.issuer ? providerFromIssuer(initial.issuer) : "entra");
  const [issuer, setIssuer] = useState(initial.issuer);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [buttonLabel, setButtonLabel] = useState(initial.buttonLabel);
  const [busy, setBusy] = useState<null | "save" | "test" | "toggle" | "remove">(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [test, setTest] = useState<{ shown: number; result: TestResult | null } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const p = providerByKey(provider);
  const issuerChanged = saved.exists && norm(issuer) !== norm(saved.issuer);
  const dirty = !saved.exists || issuerChanged || clientId.trim() !== saved.clientId || buttonLabel.trim() !== saved.buttonLabel || clientSecret !== "";
  const chip = ssoChip(saved.enabled, saved.lastTestOk);
  // Locked until a test passed for what is saved, and nothing that would void it is edited.
  const locked = !saved.enabled && !(saved.lastTestOk && !issuerChanged);

  async function post(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch("/api/admin/sso", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, issuer, clientId, clientSecret, buttonLabel: buttonLabel.slice(0, 40) }),
    });
    if (res.ok) {
      setSaved((s) => ({
        exists: true, enabled, issuer: issuer.trim(), clientId: clientId.trim(), buttonLabel: buttonLabel.trim(),
        hasSecret: s.hasSecret || clientSecret.length > 0,
        // The server forgets a test result when the issuer changes.
        lastTestOk: norm(issuer) === norm(s.issuer) ? s.lastTestOk : false,
      }));
      setClientSecret("");
      return { ok: true };
    }
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error };
  }

  // Save keeps SSO as it is, except that a changed issuer turns it off until tested.
  async function save(): Promise<boolean> {
    const enabled = saved.enabled && !issuerChanged;
    const r = await post(enabled);
    if (!r.ok) {
      setNotice({ ok: false, msg: SAVE_ERRORS[r.error ?? ""] ?? "Couldn't save. Check the fields." });
      return false;
    }
    setNotice(saved.enabled && !enabled
      ? { ok: true, msg: "Saved. SSO is off until the new issuer passes the test." }
      : { ok: true, msg: "Saved." });
    router.refresh();
    return true;
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setNotice(null);
    try { await save(); } finally { setBusy(null); }
  }

  async function runTest() {
    setBusy("test");
    setNotice(null);
    timers.current.forEach(clearTimeout);
    timers.current = [];
    try {
      if (dirty && !(await save())) return;
      setTest({ shown: 0, result: null });
      const res = await fetch("/api/admin/sso/test", { method: "POST" });
      const result = (await res.json().catch(() => null)) as TestResult | null;
      const r: TestResult = result && Array.isArray(result.steps) ? result : { ok: false, error: "unreachable", steps: [] };
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduce) setTest({ shown: r.steps.length, result: r });
      else {
        setTest({ shown: 0, result: r });
        r.steps.forEach((_, i) => timers.current.push(setTimeout(() => setTest({ shown: i + 1, result: r }), STEP_MS * (i + 1))));
      }
      const done = () => {
        setSaved((s) => ({ ...s, lastTestOk: r.ok }));
        setNotice(r.ok ? null : { ok: false, msg: TEST_ERRORS[r.error ?? ""] ?? "Couldn't test the connection." });
        if (r.ok) setToast({ ok: true, msg: saved.enabled ? "Connection test passed" : "Test passed. You can switch SSO on now." });
        router.refresh();
      };
      if (reduce) done();
      else timers.current.push(setTimeout(done, STEP_MS * Math.max(1, r.steps.length)));
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    if (busy) return;
    if (locked) {
      setToast({ ok: false, msg: "Test the connection first" });
      return;
    }
    setBusy("toggle");
    setNotice(null);
    try {
      const next = !saved.enabled;
      const r = await post(next);
      if (!r.ok) setNotice({ ok: false, msg: SAVE_ERRORS[r.error ?? ""] ?? "Couldn't change SSO." });
      else {
        setToast({ ok: true, msg: next ? "SSO is on" : "SSO is off" });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setBusy("remove");
    try {
      const res = await fetch("/api/admin/sso", { method: "DELETE" });
      if (res.ok) window.location.reload();
      else { setNotice({ ok: false, msg: "Couldn't remove the provider." }); setConfirmRemove(false); }
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setToast({ ok: false, msg: "Couldn't copy. Select the address and copy it." });
    }
  }

  const testBox = test && (() => {
    const r = test.result;
    const finished = r !== null && test.shown >= r.steps.length;
    const cls = !finished ? "so-test" : r!.ok ? "so-test ok" : "so-test bad";
    return (
      <div className={cls} role="status" aria-live="polite">
        {STEP_ORDER.map((k, i) => {
          const s = r && i < test.shown ? r.steps.find((x) => x.key === k) : undefined;
          const running = !s && (r === null ? i === 0 : i === test.shown && i < r.steps.length);
          const state = s ? (s.ok ? "ok" : "bad") : running ? "run" : "idle";
          return (
            <span key={k} className={`so-step ${state}`}>
              <span className="so-step-mark" aria-hidden="true">{state === "ok" ? "✓" : state === "bad" ? "×" : state === "run" ? <span className="so-spin" /> : ""}</span>
              {STEP_LABELS[k]}
              <span className="so-step-meta mono">{s ? s.detail : state === "idle" && finished ? "not run" : ""}</span>
            </span>
          );
        })}
      </div>
    );
  })();

  // What the sign-in page shows today: the tenant's provider once tested or on,
  // otherwise Captivo ID's button when that is the default.
  const showOwn = saved.exists && (saved.enabled || saved.lastTestOk);
  const showCaptivo = !saved.exists && captivoId;
  const previewLabel = (buttonLabel.trim() || saved.buttonLabel || "Sign in with SSO").slice(0, 40);

  return (
    <div className="so-grid">
      <form className="so-card" onSubmit={onSave}>
        <div className="so-card-head">
          <span className="so-card-t">
            <span className="so-card-title">SSO on the sign-in page<span className={`so-chip ${chip}`}>{chip === "on" ? "On" : chip === "ready" ? "Ready" : "Off"}</span></span>
            <span className="cell-sub">
              {saved.enabled
                ? "Admins and operators see your provider's button on the sign-in page."
                : locked
                  ? "Test the IdP connection first. The switch unlocks once the test passes."
                  : "The test passed. Switch it on to show the button on the sign-in page."}
            </span>
          </span>
          <button type="button" role="switch" aria-checked={saved.enabled} aria-disabled={locked} aria-label="SSO on the sign-in page"
            className={`toggle${saved.enabled ? " on" : ""}${locked ? " so-locked" : ""}`} onClick={() => void toggle()} disabled={busy === "toggle"}>
            <span />
          </button>
        </div>

        <div className="so-body">
          <div className="so-field">
            <span className="so-label">Identity provider</span>
            <div className="so-provs" role="radiogroup" aria-label="Identity provider">
              {PROVIDERS.map((x) => (
                <button key={x.key} type="button" role="radio" aria-checked={provider === x.key} className={provider === x.key ? "so-prov on" : "so-prov"} onClick={() => setProvider(x.key)}>
                  <span className={`so-tile ${x.key}`} aria-hidden="true">{x.mono}</span>{x.label}
                </button>
              ))}
            </div>
          </div>

          <div className="so-field">
            <span className="so-label">Register this redirect URI in your IdP</span>
            <div className="so-uri">
              <code className="mono">{redirectUri}</code>
              <button type="button" className="btn sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            </div>
            <span className="so-scopes cell-sub">Request scopes <code>openid</code><code>email</code><code>profile</code></span>
          </div>

          <label className="so-field">
            <span className="so-label">Issuer URL</span>
            <input className="input mono" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder={p.issuerPlaceholder} autoComplete="off" spellCheck={false} />
          </label>
          <div className="so-two">
            <label className="so-field">
              <span className="so-label">Client ID</span>
              <input className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label className="so-field">
              <span className="so-label">Client secret{saved.hasSecret && <span className="so-label-note">saved · blank keeps it</span>}</span>
              <input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password"
                placeholder={saved.hasSecret ? "••••••••" : ""} />
            </label>
          </div>
          <label className="so-field">
            <span className="so-label">Button label<span className="so-label-note">{buttonLabel.length}/40</span></span>
            <input className="input" value={buttonLabel} maxLength={40} onChange={(e) => setButtonLabel(e.target.value)} placeholder={p.buttonPlaceholder} />
          </label>

          {testBox}
          {notice && <p className={notice.ok ? "so-notice ok" : "so-notice bad"} role="alert">{notice.msg}</p>}
        </div>

        <div className="so-foot">
          <button type="submit" className="btn primary" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save"}</button>
          <button type="button" className="btn" onClick={() => void runTest()} disabled={busy !== null}>
            {busy === "test" && <span className="so-spin" aria-hidden="true" />}Test IdP connection
          </button>
          <span className="so-foot-gap" />
          {saved.exists && (
            <button type="button" className={confirmRemove ? "btn so-remove sure" : "btn so-remove"} onClick={() => void remove()} onBlur={() => setConfirmRemove(false)} disabled={busy !== null}>
              {busy === "remove" ? "Removing…" : confirmRemove ? "Sure? Remove provider" : "Remove provider"}
            </button>
          )}
        </div>
      </form>

      <aside className="so-aside" aria-label="Sign-in page preview">
        <span className="so-aside-k">Sign-in page preview</span>
        <div className="so-login">
          <span className="so-login-brand">Captivo Access</span>
          <b className="so-login-h">Sign in</b>
          <span className="so-login-btn pk">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.5 12.5 21 2" /><path d="M16 7l3 3" /></svg>
            Sign in with passkey
          </span>
          {showOwn && (
            <span className="so-login-btn sso"><span className={`so-tile sm ${providerFromIssuer(saved.issuer || issuer)}`} aria-hidden="true">{providerByKey(providerFromIssuer(saved.issuer || issuer)).mono}</span>{previewLabel}</span>
          )}
          {showCaptivo && <span className="so-login-btn sso"><span className="so-tile sm captivo" aria-hidden="true">C</span>Sign in with Captivo</span>}
        </div>
        <span className="cell-sub">
          {showOwn
            ? saved.enabled ? "Shown now." : "Appears once you switch SSO on."
            : showCaptivo ? "Shown now: Captivo ID is the default until you add your own provider."
              : "Only the passkey button until a provider passes the test."}
          {" "}Vendors keep signing in with their passkey.
        </span>
      </aside>

      {toast && <div className="toast" role="status"><span className={toast.ok ? undefined : "so-toast-warn"}>{toast.ok ? "✓" : "!"}</span>{toast.msg}</div>}
    </div>
  );
}
