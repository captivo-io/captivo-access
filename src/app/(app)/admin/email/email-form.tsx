"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PRESETS, presetFor, type PresetKey } from "./presets";

type Initial = {
  host: string; port: number; secure: boolean; username: string;
  fromName: string; fromEmail: string; enabled: boolean; hasPassword: boolean;
};
type Mode = "own" | "platform" | "none";

const MODE_TEXT: Record<Mode, string> = {
  own: "Now: this server sends invites and alerts.",
  platform: "Now: the Captivo platform's mail server sends invites and alerts.",
  none: "Now: invites are copyable links, alerts go to the console bell.",
};
const SAVE_ERRORS: Record<string, string> = {
  host_port_from_required: "SMTP server, port and sender email are required.",
  password_required: "Enter the password once; it is kept after that.",
};
const TEST_ERRORS: Record<string, string> = {
  not_configured: "Save your SMTP settings first.",
  private_address: "That mail server is on a private or internal network; the cloud service can't connect to it.",
};

export function EmailForm({ initial, adminEmail, mode, preview }: {
  initial: Initial; adminEmail: string; mode: Mode; preview: { subject: string; html: string };
}) {
  const router = useRouter();
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [secure, setSecure] = useState(initial.secure);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(initial.fromName);
  const [fromEmail, setFromEmail] = useState(initial.fromEmail);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hasPassword, setHasPassword] = useState(initial.hasPassword);
  const [preset, setPreset] = useState<PresetKey | null>(initial.host ? presetFor(initial.host) : null);
  const [hostHint, setHostHint] = useState("smtp.example.com");
  const [testTo, setTestTo] = useState(adminEmail);
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  function pick(k: PresetKey) {
    const p = PRESETS.find((x) => x.key === k)!;
    setPreset(k);
    if (p.host !== null) setHost(p.host);
    else if (k === "ses") setHost("");
    if (p.hostHint) setHostHint(p.hostHint);
    if (p.port) { setPort(String(p.port)); setSecure(p.secure); }
  }

  function encryption(tls: boolean) {
    setSecure(tls);
    setPort(tls ? "465" : "587");
  }

  async function save(): Promise<boolean> {
    const res = await fetch("/api/admin/smtp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port: Number(port), secure, username, password, fromName, fromEmail, enabled }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice({ ok: false, msg: SAVE_ERRORS[j.error ?? ""] ?? "Couldn't save. Check the fields." });
      return false;
    }
    if (password) setHasPassword(true);
    setPassword("");
    router.refresh();
    return true;
  }

  async function onSave(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy("save");
    setNotice(null);
    try {
      if (await save()) setNotice({ ok: true, msg: "Saved." });
    } finally {
      setBusy(null);
    }
  }

  async function onTest(e: React.FormEvent) {
    e.preventDefault();
    setBusy("test");
    setNotice(null);
    setResult(null);
    try {
      if (!(await save())) return;
      const res = await fetch("/api/admin/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo }),
      });
      const r = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string; response?: string };
      setResult(r.sent
        ? { ok: true, msg: `Test email sent to ${testTo}${r.response ? ` · ${r.response.slice(0, 60)}` : ""}` }
        : { ok: false, msg: TEST_ERRORS[r.reason ?? ""] ?? `The server refused it: ${r.reason ?? "unknown error"}` });
    } finally {
      setBusy(null);
    }
  }

  const from = `${fromName || "Captivo Access"} <${fromEmail || "no-reply@example.com"}>`;

  return (
    <div className="em-grid">
      <div className="em-card">
        <div className="em-card-head">
          <span className="em-card-t">
            <span className="em-card-title">Send email with these settings<span className={enabled ? "em-chip on" : "em-chip"}>{enabled ? "On" : "Off"}</span></span>
            <span className="cell-sub">
              {enabled
                ? "Invites and alerts go out through this server."
                : mode === "platform"
                  ? "While off, the Captivo platform's mail server sends this workspace's invites and alerts."
                  : "While off, invites are copyable links and alerts appear only in the console bell."}
            </span>
          </span>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Send email with these settings"
            className={enabled ? "toggle on" : "toggle"} onClick={() => setEnabled((v) => !v)}><span /></button>
        </div>

        <form className="em-body" onSubmit={(e) => void onSave(e)} id="em-settings">
          <div className="em-field">
            <span className="em-label">Preset</span>
            <div className="em-presets" role="group" aria-label="Preset">
              {PRESETS.map((p) => (
                <button key={p.key} type="button" className={preset === p.key ? "fpill on" : "fpill"} aria-pressed={preset === p.key} onClick={() => pick(p.key)}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="em-hostport">
            <label className="em-field">
              <span className="em-label">SMTP server</span>
              <input className="input mono" value={host} onChange={(e) => { setHost(e.target.value); setPreset(presetFor(e.target.value)); }} placeholder={hostHint} autoComplete="off" spellCheck={false} />
            </label>
            <label className="em-field">
              <span className="em-label">Port</span>
              <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
            </label>
          </div>
          <div className="em-field">
            <span className="em-label">Encryption</span>
            <div className="seg em-enc" role="group" aria-label="Encryption">
              <button type="button" className={secure ? "seg-opt" : "seg-opt on"} aria-pressed={!secure} onClick={() => encryption(false)}>STARTTLS<span className="mono t-muted">587</span></button>
              <button type="button" className={secure ? "seg-opt on" : "seg-opt"} aria-pressed={secure} onClick={() => encryption(true)}>TLS<span className="mono t-muted">465</span></button>
            </div>
          </div>
          <div className="em-two">
            <label className="em-field">
              <span className="em-label">Username</span>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="em-field">
              <span className="em-label">Password
                <span className="em-label-note">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                  stored encrypted, never shown again
                </span>
              </span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
                placeholder={hasPassword ? "•••••••• (blank keeps it)" : ""} />
            </label>
          </div>
          <div className="em-two">
            <label className="em-field">
              <span className="em-label">Sender name</span>
              <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} />
            </label>
            <label className="em-field">
              <span className="em-label">Sender email</span>
              <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="no-reply@example.com" />
            </label>
          </div>
          {notice && <p className={notice.ok ? "em-notice ok" : "em-notice bad"} role="alert">{notice.msg}</p>}
        </form>

        <form className="em-test" onSubmit={(e) => void onTest(e)}>
          <label className="em-label" htmlFor="em-test-to">Send a test email</label>
          <div className="em-test-row">
            <input id="em-test-to" className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} required />
            <button type="submit" className="btn" disabled={busy !== null}>
              {busy === "test" && <span className="em-spin" aria-hidden="true" />}Save &amp; send test
            </button>
          </div>
          {result && <span className={result.ok ? "em-result ok" : "em-result bad"} role="status"><b aria-hidden="true">{result.ok ? "✓" : "×"}</b>{result.msg}</span>}
        </form>

        <div className="em-foot">
          <button type="submit" form="em-settings" className="btn primary" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save"}</button>
          <span className="cell-sub">{MODE_TEXT[mode]}</span>
        </div>
      </div>

      <aside className="em-aside" aria-label="Invite email preview">
        <span className="em-aside-k">Invite email preview</span>
        <div className="em-mail">
          <div className="em-mail-head">
            <span><span className="t-muted">From</span><b>{from}</b></span>
            <span><span className="t-muted">Subject</span><b>{preview.subject}</b></span>
          </div>
          <iframe className="em-mail-body" title="Invite email preview" sandbox="" srcDoc={fitPreview(preview.html)} />
        </div>
        <span className="cell-sub">The email people get with their invite link. The link and name here are examples.</span>
      </aside>
    </div>
  );
}

// The email is laid out for a 600px mail client; shrink it to the narrow aside.
function fitPreview(html: string): string {
  const style = "<style>html{zoom:.6}</style>";
  return html.includes("</head>") ? html.replace("</head>", `${style}</head>`) : style + html;
}
