"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { sealSecret } from "@/lib/vault/seal";

// The directory account password rotation resets passwords with (it holds the
// "Reset password" right). Sealed here to every connector, for this directory's
// host and port; the cloud cannot open it (api/admin/directory/reset-account).

export type ResetAccountProps = {
  host: string;
  port: number;
  security: string;
  username: string;
  missingFor: string[];
  keys: { name: string; key: string }[];
};

export function ResetAccount({ host, port, security, username, missingFor, keys }: ResetAccountProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(username);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const encrypted = security === "LDAPS" || security === "STARTTLS";

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const target = { host, port, username: user.trim() };
      const seals = Object.fromEntries(await Promise.all(keys.map(async (k) => [k.key, await sealSecret(k.key, secret, target, "reconcile")] as const)));
      const res = await fetch("/api/admin/directory/reset-account", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user.trim(), host, port, seals }) });
      if (!res.ok) {
        const r = await res.json().catch(() => null);
        setMsg({ tone: "bad", text: r?.error === "directory_changed" ? "The directory settings changed. Reload the page." : "It could not be saved." });
        return;
      }
      setSecret("");
      setOpen(false);
      setMsg({ tone: "ok", text: "Saved." });
      router.refresh();
    } catch {
      setMsg({ tone: "bad", text: "This browser cannot seal secrets. Use a current browser." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/admin/directory/reset-account", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    router.refresh();
  }

  return (
    <section className="rot">
      <div className="rot-head">
        <div>
          <h2>Password reset account</h2>
          <p className="cell-sub">For password rotation of RDP resources with a domain account. When an account cannot change its own password (Active Directory allows one change a day by default) or its saved password no longer matches, this account resets it. Give it the <b>Reset password</b> right on those users only; it does not need to be a domain admin.</p>
        </div>
        <span className={`rot-pill ${username ? "ok" : "off"}`}><i aria-hidden="true" />{username ? "Set" : "Not set"}</span>
      </div>
      {!host ? <p className="rf-msg warn">Save the directory connection first.</p> : !encrypted ? <p className="rf-msg warn">Active Directory changes passwords only over an encrypted connection: set the directory to LDAPS or StartTLS.</p> : (
        <>
          {username && <p className="cell-sub">Signs in as <b className="mono">{username}</b> to {host}:{port}.{missingFor.length ? ` ${missingFor.join(", ")} has no copy yet; it is copied within a few minutes.` : ""}</p>}
          {!open ? (
            <div className="rot-actions">
              <button type="button" className="btn sm" onClick={() => setOpen(true)}>{username ? "Change" : "Add reset account"}</button>
              {username && <button type="button" className="btn sm" disabled={busy} onClick={() => void remove()}>Remove</button>}
            </div>
          ) : (
            <div className="rot-rec-form">
              <label className="rq-sec"><span className="rq-label"><span>User</span></span>
                <input className="input mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="CORP\svc-captivo-reset" autoComplete="off" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Password</span></span>
                <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" /></label>
              <p className="rf-hint rot-wide">Sealed in this browser to {keys.length ? keys.map((k) => k.name).join(", ") : "your connectors"}; Captivo cannot open it, and a connector uses it only against {host}.</p>
              <div className="rot-actions rot-wide">
                <button type="button" className="btn sm" onClick={() => { setOpen(false); setSecret(""); }}>Cancel</button>
                <button type="button" className="btn sm ink" disabled={!user.trim() || !secret || busy || keys.length === 0} onClick={() => void save()}>{busy ? "Saving…" : "Save account"}</button>
              </div>
            </div>
          )}
        </>
      )}
      {msg && <p className={`rf-msg ${msg.tone}`} role="status">{msg.text}</p>}
    </section>
  );
}
