"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { startRegistration } from "@simplewebauthn/browser";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { PASSKEY_LABEL_MAX } from "@/lib/auth/passkey-kind";
import { AccountHead } from "../account-head";

export interface PasskeyRow { id: string; label: string; createdAt: string; lastUsedAt: string | null; synced: boolean | null }

const ADD_ERRORS: Record<string, string> = {
  unauthorized: "Your session has expired, please sign in again.",
  challenge_expired: "The session timed out, please try again.",
  verification_failed: "Passkey verification failed.",
};
const DEL_ERRORS: Record<string, string> = {
  last_passkey: "Your last passkey can't be deleted.",
  not_found: "Passkey not found.",
  unauthorized: "Your session has expired, please sign in again.",
};

/** A default name for a new passkey, from the browser it's made in. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux";
  return "New passkey";
}

/** Passkeys tab of My account (design hand-off 11, 7.24). */
export function PasskeysView({ passkeys, recoveryOn, workspace }: { passkeys: PasskeyRow[]; recoveryOn: boolean; workspace: string | null }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [before, setBefore] = useState<string[] | null>(null); // ids before the last add: anything else is "New"
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const only = passkeys.length === 1;

  async function add() {
    setError(null);
    setAdding(true);
    cancelled.current = false;
    try {
      const optionsRes = await fetch("/api/auth/registration/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "add" }),
      });
      const options = await optionsRes.json().catch(() => ({}));
      if (!optionsRes.ok) { setError(ADD_ERRORS[options?.error] ?? "Couldn't add the passkey, please try again."); return; }
      const response = await startRegistration({ optionsJSON: options });
      if (cancelled.current) return;
      const verifyRes = await fetch("/api/auth/registration/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "add", response, label: deviceLabel() }),
      });
      const result = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !result?.ok) { setError(ADD_ERRORS[result?.error] ?? "Couldn't add the passkey, please try again."); return; }
      setBefore(passkeys.map((p) => p.id));
      setToast("Passkey added");
      router.refresh();
    } catch (e) {
      // The person closed the browser's prompt: not an error worth a banner.
      if (!(e instanceof Error && e.name === "NotAllowedError")) setError("Couldn't add the passkey, please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function rename(id: string) {
    const label = draft.trim();
    if (!label) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/passkeys/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
      if (!res.ok) { setError("Couldn't rename the passkey. Use 1 to 40 characters."); return; }
      setEditing(null);
      setToast("Passkey renamed");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (confirmDel !== id) { setConfirmDel(id); return; }
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/passkeys/${id}`, { method: "DELETE" });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.ok) { setError(DEL_ERRORS[result?.error] ?? "Couldn't delete the passkey, please try again."); return; }
      setConfirmDel(null);
      setToast("Passkey deleted");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ac">
      <AccountHead tab="passkeys" title="My passkeys" workspace={workspace} recoveryOn={recoveryOn}
        sub="Passkeys linked to this account. At least one must remain so your account doesn't get locked out."
        action={<button type="button" className="btn primary" onClick={() => void add()} disabled={adding}>+ Add a new passkey</button>} />

      {only && (
        <div className="ac-warn">
          <span className="ac-warn-ic"><NavIcon name="shield" size={15} /></span>
          <span className="ac-warn-t">
            <strong>You have only one passkey.</strong>{" "}
            {recoveryOn ? "Adding a second device is recommended; recovery is set up." : "If you lose this device you can't sign in. Add a second device or set up recovery."}
          </span>
          {!recoveryOn && <Link href="/settings/recovery" className="btn sm ac-warn-b">Set up recovery →</Link>}
        </div>
      )}

      {adding && (
        <div className="ac-wait" role="status">
          <span className="ac-wait-ic"><span className="ac-spin" /></span>
          <span className="ac-wait-t"><b>Confirm in your browser&apos;s prompt</b><span>Verify with Touch ID, Windows Hello or a security key.</span></span>
          <button type="button" className="btn sm" onClick={() => { cancelled.current = true; setAdding(false); }}>Cancel</button>
        </div>
      )}

      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="ac-list">
        {passkeys.length === 0 && <div className="au-empty">No passkeys yet.</div>}
        {passkeys.map((p) => {
          const isNew = before !== null && !before.includes(p.id);
          return (
            <article key={p.id} className={isNew ? "ac-pk new" : "ac-pk"}>
              <span className="ac-pk-ic"><NavIcon name="key" size={20} /></span>
              <div className="ac-pk-main">
                {editing === p.id ? (
                  <form className="ac-pk-edit" onSubmit={(e) => { e.preventDefault(); void rename(p.id); }}>
                    <input className="input" value={draft} maxLength={PASSKEY_LABEL_MAX} onChange={(e) => setDraft(e.target.value)} aria-label="Rename" autoFocus />
                    <button type="submit" className="btn sm primary" disabled={busy === p.id || !draft.trim()}>Save</button>
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <span className="ac-pk-n">
                    <b>{p.label}</b>
                    <button type="button" className="ac-pk-pen" aria-label="Rename" title="Rename" onClick={() => { setEditing(p.id); setDraft(p.label); }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                    </button>
                    {isNew && <span className="ac-chip ok">New</span>}
                    {p.synced !== null && <span className="ac-chip">{p.synced ? "SYNCED" : "SECURITY KEY"}</span>}
                  </span>
                )}
                <span className="ac-pk-meta">
                  <span>Created <LocalTime iso={p.createdAt} mode="short" /></span>
                  <span>{p.lastUsedAt ? <>Last used <LocalTime iso={p.lastUsedAt} mode="short" /></> : "Not used yet"}</span>
                </span>
              </div>
              <div className="ac-pk-del">
                <button type="button" className={confirmDel === p.id ? "btn sm danger solid" : "btn sm danger"} disabled={only || busy === p.id}
                  title={only ? "Your last passkey can't be deleted" : undefined} onClick={() => void remove(p.id)} onBlur={() => setConfirmDel((c) => (c === p.id ? null : c))}>
                  {confirmDel === p.id ? "Sure? Delete" : "Delete"}
                </button>
                {only && <span className="cell-sub">Your last passkey can&apos;t be deleted</span>}
              </div>
            </article>
          );
        })}
      </div>
      <p className="ac-note">Passkeys live on your device; Captivo stores only the public key. Deleting a passkey stops sign-in from that device.</p>
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}
