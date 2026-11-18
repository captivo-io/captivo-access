"use client";
import { useEffect, useRef, useState } from "react";
import { resolveConnectorChoice } from "@/lib/directory/connector-selection";
import { TEST_STEPS, readDirectoryTest, pemState, type TestOutcome } from "@/lib/directory/test-steps";

type Security = "PLAIN" | "STARTTLS" | "LDAPS";
export type DirectoryInitial = {
  enabled: boolean;
  connectorId: string;
  host: string;
  port: number;
  security: Security;
  insecureSkipVerify: boolean;
  caCertPem: string;
  baseDN: string;
  bindDN: string;
  hasBindPassword: boolean;
};
export type ConnectorOption = { id: string; name: string; online: boolean };

const SECURITY: { key: Security; label: string; port: number; sub: string; bad?: boolean }[] = [
  { key: "LDAPS", label: "LDAPS", port: 636, sub: "Recommended · TLS from the start" },
  { key: "STARTTLS", label: "STARTTLS", port: 389, sub: "Upgrades 389 to TLS" },
  { key: "PLAIN", label: "Unencrypted", port: 389, sub: "Not recommended · password sent in clear", bad: true },
];
const STEP_MS = 550;

type Run = { phase: "running"; at: number } | { phase: "done"; outcome: TestOutcome; at: number };

/** Card 1: the switch, 01 · CONNECTION, 02 · SERVICE ACCOUNT, the connection test and Save. */
export function ConnectionCard({
  initial, connectors, lastTestOk, lastTestDetail, onSaved, onTested,
}: {
  initial: DirectoryInitial;
  connectors: ConnectorOption[];
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  onSaved: (s: { configured: boolean; enabled: boolean; changedConnection: boolean }) => void;
  onTested: (ok: boolean) => void;
}) {
  const initialChoice = resolveConnectorChoice(initial.connectorId, connectors);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [connectorId, setConnectorId] = useState(initialChoice.value);
  const [picking, setPicking] = useState(initialChoice.value === "");
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [security, setSecurity] = useState<Security>(initial.security);
  const [insecureSkipVerify, setInsecureSkipVerify] = useState(initial.insecureSkipVerify);
  const [caCertPem, setCaCertPem] = useState(initial.caCertPem);
  const [baseDN, setBaseDN] = useState(initial.baseDN);
  const [bindDN, setBindDN] = useState(initial.bindDN);
  const [bindPassword, setBindPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(initial.hasBindPassword);
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [tick, setTick] = useState(0);
  const lastSaved = useRef(JSON.stringify({ connectorId: initial.connectorId, host: initial.host, port: String(initial.port), security: initial.security, insecureSkipVerify: initial.insecureSkipVerify, caCertPem: initial.caCertPem, baseDN: initial.baseDN, bindDN: initial.bindDN }));

  const connector = connectors.find((c) => c.id === connectorId) ?? null;
  const pem = pemState(caCertPem);
  const tls = security !== "PLAIN";

  // While the test runs, light the steps one by one; the real answer decides where it stops.
  useEffect(() => {
    if (run?.phase !== "running") return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setTick((n) => Math.min(n + 1, TEST_STEPS.length - 1)), STEP_MS);
    return () => clearInterval(t);
  }, [run?.phase]);

  function fields() {
    return { connectorId, host: host.trim(), port: port.trim(), security, insecureSkipVerify: tls && insecureSkipVerify, caCertPem: tls ? caCertPem : "", baseDN: baseDN.trim(), bindDN: bindDN.trim() };
  }

  async function save(): Promise<boolean> {
    setBusy("save");
    setError(null);
    setSavedNote(null);
    const f = fields();
    try {
      const res = await fetch("/api/admin/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, ...f, port: Number(f.port) || (security === "LDAPS" ? 636 : 389), bindPassword: bindPassword || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error === "connector_not_found" ? "That connector no longer exists. Pick a current one and save." : "Couldn't save. Check the fields.");
        return false;
      }
      const snapshot = JSON.stringify(f);
      const changedConnection = snapshot !== lastSaved.current || !!bindPassword;
      lastSaved.current = snapshot;
      if (bindPassword) setHasPassword(true);
      setBindPassword("");
      setSavedNote("Saved · just now");
      onSaved({ configured: !!(f.connectorId && f.host && f.baseDN && f.bindDN), enabled, changedConnection });
      return true;
    } catch {
      setError("Couldn't save. Check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    // The test runs on the saved settings, so unsaved edits are saved first.
    const f = JSON.stringify(fields());
    if ((f !== lastSaved.current || bindPassword) && !(await save())) return;
    setBusy("test");
    setTick(0);
    setRun({ phase: "running", at: Date.now() });
    try {
      const res = await fetch("/api/admin/directory/test", { method: "POST", headers: { "Content-Type": "application/json" } });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; baseDnFound?: boolean; error?: string };
      const outcome = readDirectoryTest(j);
      setRun({ phase: "done", outcome, at: Date.now() });
      onTested(outcome.ok);
    } catch {
      const outcome = readDirectoryTest({ ok: false, error: "The directory test request failed." });
      setRun({ phase: "done", outcome, at: Date.now() });
      onTested(false);
    } finally {
      setBusy(null);
    }
  }

  function pickSecurity(s: (typeof SECURITY)[number]) {
    setSecurity(s.key);
    setPort(String(s.port));
  }

  if (connectors.length === 0) {
    return (
      <section className="dr-card">
        <div className="dr-card-head"><span className="dr-head-t"><b>Directory integration</b><span>Add a connector first: the directory is reached through one.</span></span></div>
      </section>
    );
  }

  const tlsDetail = !tls ? "unencrypted" : insecureSkipVerify ? "verification skipped" : null;
  const stepDetail = (i: number): string | null => {
    if (i === 1 && host.trim()) return `${host.trim()}:${port.trim() || (security === "LDAPS" ? "636" : "389")}`;
    if (i === 2) return tlsDetail;
    if (i === 3 && bindDN.trim()) return bindDN.trim();
    return null;
  };

  return (
    <section className="dr-card">
      <div className="dr-card-head">
        <span className="dr-head-t">
          <b>Directory integration<span className={enabled ? "dr-state on" : "dr-state"}>{enabled ? "On" : "Off"}</span></b>
          <span>When off, the settings below are kept but not used.{enabled !== initial.enabled && " Save to apply."}</span>
        </span>
        <button type="button" role="switch" aria-checked={enabled} aria-label="Directory integration" className={enabled ? "toggle on" : "toggle"} onClick={() => setEnabled((v) => !v)}><span /></button>
      </div>

      <form className="dr-body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <span className="dr-sec">01 · CONNECTION</span>

        <div className="dr-field">
          <span className="dr-label">Connector that reaches the directory</span>
          {connector && !picking ? (
            <div className="dr-conn">
              <span className={connector.online ? "dr-conn-ic on" : "dr-conn-ic"} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" /></svg>
              </span>
              <span className="dr-conn-t"><b>{connector.name}</b><span className="mono">{connector.id.slice(0, 10)} · {connector.online ? "online" : "offline"}</span></span>
              <button type="button" className="btn sm" onClick={() => setPicking(true)}>Change</button>
            </div>
          ) : (
            <div className="dr-conn-list" role="radiogroup" aria-label="Connector">
              {connectors.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={c.id === connectorId} className={c.id === connectorId ? "dr-conn-opt on" : "dr-conn-opt"}
                  onClick={() => { setConnectorId(c.id); setPicking(false); }}>
                  <span className={c.online ? "dr-dot on" : "dr-dot"} aria-hidden="true" />
                  <b>{c.name}</b>
                  <span className="mono t-muted">{c.online ? "online" : "offline"}</span>
                </button>
              ))}
            </div>
          )}
          {initialChoice.savedMissing && connectorId === "" && (
            <span className="dr-warn">The connector saved before no longer exists or was revoked, so the directory test reports it offline. Pick a connector and save.</span>
          )}
        </div>

        <div className="dr-row hp">
          <label className="dr-field"><span className="dr-label">Host</span>
            <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="dc01.corp.example.com" spellCheck={false} />
          </label>
          <label className="dr-field"><span className="dr-label">Port</span>
            <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))} />
          </label>
        </div>

        <div className="dr-field">
          <span className="dr-label">Security</span>
          <div className="dr-radios" role="radiogroup" aria-label="Security">
            {SECURITY.map((s) => (
              <button key={s.key} type="button" role="radio" aria-checked={security === s.key} className={security === s.key ? "dr-radio on" : "dr-radio"} onClick={() => pickSecurity(s)}>
                <span className="dr-radio-h">{s.label}<span className="mono">{s.port}</span></span>
                <span className={s.bad ? "dr-radio-s bad" : "dr-radio-s"}>{s.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {tls && (
          <>
            <label className="dr-field">
              <span className="dr-label sp">
                <span>CA certificate (PEM) <span className="t-muted dr-opt">(optional)</span></span>
                <span className={`mono dr-pem ${pem}`}>{pem === "none" ? "system trust store" : pem === "ok" ? "✓ Valid PEM" : "PEM not recognised"}</span>
              </span>
              <textarea className="textarea mono dr-pem-ta" rows={4} value={caCertPem} onChange={(e) => setCaCertPem(e.target.value)} spellCheck={false}
                placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"} />
              <span className="dr-hint">Paste your internal CA or the directory&apos;s self-signed certificate so the TLS connection is verified securely. Leave empty to use the system trust store.</span>
            </label>
            <label className={insecureSkipVerify ? "dr-skip on" : "dr-skip"}>
              <input type="checkbox" checked={insecureSkipVerify} onChange={(e) => setInsecureSkipVerify(e.target.checked)} />
              <span><b>Skip TLS certificate verification</b>
                <span>{insecureSkipVerify ? "Verification is off. The connection is open to interception; use only for testing." : "Insecure: accepts any certificate. Paste the CA certificate instead."}</span>
              </span>
            </label>
          </>
        )}

        <span className="dr-divider" />
        <span className="dr-sec">02 · SERVICE ACCOUNT</span>

        <label className="dr-field"><span className="dr-label">Base DN</span>
          <input className="input mono" value={baseDN} onChange={(e) => setBaseDN(e.target.value)} placeholder="DC=corp,DC=example,DC=com" spellCheck={false} />
        </label>
        <div className="dr-row two">
          <label className="dr-field"><span className="dr-label">Bind user (service account)</span>
            <input className="input mono" value={bindDN} onChange={(e) => setBindDN(e.target.value)} placeholder="captivo@corp.example.com" spellCheck={false} autoComplete="off" />
          </label>
          <label className="dr-field"><span className="dr-label">Password</span>
            <span className="dr-pw">
              <input className="input" type={showPw ? "text" : "password"} value={bindPassword} onChange={(e) => setBindPassword(e.target.value)}
                placeholder={hasPassword ? "•••••••• (unchanged)" : ""} autoComplete="new-password" />
              <button type="button" className="dr-pw-btn mono" onClick={() => setShowPw((v) => !v)}>{showPw ? "HIDE" : "SHOW"}</button>
            </span>
          </label>
        </div>
        <span className="dr-hint">For Active Directory a UPN <code>user@domain</code> / <code>DOMAIN\user</code> works and is simpler than a full DN. OpenLDAP needs the full bind DN: <code>CN=…,DC=…</code></span>

        {run && (
          <div className={run.phase === "running" ? "dr-test" : run.outcome.ok ? "dr-test ok" : "dr-test bad"} role="status" aria-live="polite">
            {TEST_STEPS.map((label, i) => {
              let state: "wait" | "run" | "ok" | "bad" | "skip";
              if (run.phase === "running") state = i < tick ? "ok" : i === tick ? "run" : "wait";
              else if (run.outcome.failedAt === null || i < run.outcome.failedAt) state = "ok";
              else if (i === run.outcome.failedAt) state = "bad";
              else state = "skip";
              const label2 = i === 2 && !tls ? "TLS handshake (none: unencrypted)" : label;
              const detail = state === "bad" ? null : run.phase === "done" ? stepDetail(i) : null;
              return (
                <div key={label} className={`dr-step ${state}`}>
                  <span className="dr-step-dot" aria-hidden="true">{state === "ok" ? "✓" : state === "bad" ? "×" : ""}</span>
                  <span className="dr-step-l">{label2}{state === "skip" && <span className="t-muted"> · not run</span>}</span>
                  {detail && <span className="mono dr-step-d">{detail}</span>}
                </div>
              );
            })}
            {run.phase === "done" && run.outcome.message && <p className="dr-test-msg">{run.outcome.message}</p>}
          </div>
        )}
        {!run && lastTestOk === false && lastTestDetail && (
          <p className="dr-test-last">Last test failed: {lastTestDetail}</p>
        )}
        {error && <p className="notice error" role="alert">{error}</p>}
      </form>

      <div className="dr-foot">
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" disabled={busy !== null || !connectorId} onClick={() => void test()}>
          {busy === "test" && <span className="dr-spin" aria-hidden="true" />}Test connection
        </button>
        {savedNote && <span className="dr-saved">{savedNote}</span>}
      </div>
    </section>
  );
}
