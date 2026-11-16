"use client";
import { useState } from "react";
import { useConfirm } from "@/app/(app)/_shell/confirm-dialog";

type Initial = { enabled: boolean; issuer: string; clientId: string; buttonLabel: string; hasSecret: boolean };

export function SsoForm({ initial, canRemove, captivoId }: { initial: Initial; canRemove: boolean; captivoId: boolean }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [issuer, setIssuer] = useState(initial.issuer);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [buttonLabel, setButtonLabel] = useState(initial.buttonLabel);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/sso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, issuer, clientId, clientSecret, buttonLabel }),
      });
      if (res.ok) {
        setNotice({ kind: "ok", msg: "Saved." });
        setClientSecret("");
      } else {
        const j = await res.json().catch(() => ({}));
        const map: Record<string, string> = {
          issuer_client_required: "Issuer and Client ID are required.",
          secret_required: "Add the Client secret before enabling SSO.",
          captivo_id_issuer: "That is Captivo's own sign-in, which is already used when no provider is set here.",
        };
        setNotice({ kind: "error", msg: map[j.error] ?? "Couldn't save — check the fields." });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const msg = captivoId
      ? "Remove your identity provider? Users will sign in with Captivo again."
      : "Remove your identity provider? The login page will have no SSO button.";
    if (!(await confirm(msg, { danger: true }))) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/sso", { method: "DELETE" });
      if (res.ok) window.location.reload();
      else setNotice({ kind: "error", msg: "Couldn't remove the provider." });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/sso/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) {
        setNotice({ kind: "ok", msg: "IdP reachable — discovery succeeded." });
      } else {
        const map: Record<string, string> = {
          no_issuer: "Save your Issuer URL first.",
          unreachable: "Couldn't reach the IdP — check the Issuer URL.",
        };
        setNotice({ kind: "error", msg: map[j.error] ?? "Couldn't test the IdP connection." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      {dialog}
      <div className="setting" style={{ marginBottom: "1.1rem" }}>
        <div className="setting-main">
          <div className="setting-label">Enable SSO on the login page</div>
          <div className="setting-hint">Shows the sign-in button below for staff/admins to authenticate with your identity provider. Vendors always use passkeys.</div>
        </div>
        <div className="setting-ctl">
          <label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span className="track" /></label>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="sso-issuer">Issuer URL</label>
        <input
          id="sso-issuer"
          className="input"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
          required
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="sso-client-id">Client ID</label>
        <input id="sso-client-id" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="sso-client-secret">
          Client secret {initial.hasSecret && <span className="cell-sub">(stored — leave blank to keep)</span>}
        </label>
        <input
          id="sso-client-secret"
          type="password"
          className="input"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="new-password"
          placeholder={initial.hasSecret ? "•••••••• (leave blank to keep current)" : ""}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="sso-button-label">Button label</label>
        <input id="sso-button-label" className="input" value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} placeholder="Sign in with Microsoft" />
      </div>
      {notice && <p className={`notice ${notice.kind === "ok" ? "success" : "error"}`} role="alert">{notice.msg}</p>}
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "…" : "Save"}</button>
        <button type="button" className="btn" onClick={test} disabled={busy}>{busy ? "…" : "Test IdP connection"}</button>
        {canRemove && <button type="button" className="btn danger" onClick={remove} disabled={busy}>{busy ? "…" : "Remove provider"}</button>}
      </div>
    </form>
  );
}
