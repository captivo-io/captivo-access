"use client";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { openSealedSecret, revealKeyPair } from "@/lib/vault/seal";

type State = {
  block: string | null;
  blockText: string | null;
  maxMinutes: number;
  grantEnds: string | null;
  willRotate: boolean;
  waiting: string | null;
  active: { mine: boolean; who: string; until: string } | null;
};
type Taken = { password: string; user: string; host: string; until: string; willRotate: boolean };

const ERRORS: Record<string, string> = {
  reason_required: "Say why you need it (at least 10 characters). The reason goes into the audit log.",
  forbidden: "Your access to this resource isn't active right now.",
  checked_out: "Someone else has it checked out.",
  grant_ended: "Your access ends before the check-out could start.",
};

function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * "Check out password": take the saved password to use yourself, for a while and
 * for a reason. It is opened only in this browser; when the time is up or you
 * give it back, it is changed.
 */
export function CheckoutButton({ href, siteName }: { href: string; siteName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)} title="Take this resource's password for a while, to use it yourself.">Check out</button>
      {open && <CheckoutModal href={href} siteName={siteName} onClose={() => setOpen(false)} />}
    </>
  );
}

function CheckoutModal({ href, siteName, onClose }: { href: string; siteName: string; onClose: () => void }) {
  const [st, setSt] = useState<State | null>(null);
  const [reason, setReason] = useState("");
  const [taken, setTaken] = useState<Taken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(href, { cache: "no-store" });
    const j = (await res.json().catch(() => null)) as State | null;
    if (res.ok && j) setSt(j);
    else setError("Couldn't load this resource's check-out details. Try again in a moment.");
  }, [href]);
  useEffect(() => { void load(); }, [load]);

  async function take() {
    setBusy(true);
    setError(null);
    try {
      const own = await revealKeyPair();
      const res = await fetch(href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason, publicKey: own.publicKey }) });
      const j = (await res.json().catch(() => null)) as { error?: string; detail?: string; by?: string; sealed?: string; target?: { host: string; port: number; username: string }; endsAt?: string; willRotate?: boolean } | null;
      if (!res.ok || !j?.sealed || !j.target) {
        setError(j?.error === "checked_out" && j.by ? `${j.by} has it checked out.` : j?.detail ?? ERRORS[j?.error ?? ""] ?? "Couldn't check it out. Try again in a moment.");
        void load();
        return;
      }
      const password = await openSealedSecret(own, j.sealed, j.target);
      setTaken({ password, user: j.target.username, host: j.target.host, until: j.endsAt ?? "", willRotate: !!j.willRotate });
      void load();
    } catch {
      setError("The password could not be opened in this browser. Use a current Chrome, Edge, Firefox or Safari.");
    } finally {
      setBusy(false);
    }
  }

  async function giveBack() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "return" }) });
      if (!res.ok) setError("Couldn't give it back. Try again in a moment.");
      else { setTaken(null); await load(); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Check out ${siteName}`} subtitle="Take the password to use it yourself." size="sm">
      <div className="ssh-cmd">
        {taken ? (
          <>
            <p className="cell-sub">For <span className="mono">{taken.user}@{taken.host}</span>. It is opened in this browser only, and shown once: copy it now.</p>
            <div className="ssh-box"><code>{taken.password}</code><CopyButton value={taken.password} /></div>
            <p className="ssh-timer">Yours until <b className="mono">{taken.until ? hm(taken.until) : ""}</b>. {taken.willRotate ? "Then it is changed." : "This resource's password is not changed automatically: your administrators were told."}</p>
            <div className="row-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void giveBack()}>Give it back now</button>
              <button type="button" className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : !st ? (
          <p className="cell-sub">{error ?? "Loading…"}</p>
        ) : st.block ? (
          <p className="ssh-err" role="alert">{st.blockText}</p>
        ) : st.active && !st.active.mine ? (
          <p className="ssh-err" role="alert">{st.active.who} has it checked out until {hm(st.active.until)}.</p>
        ) : st.active?.mine ? (
          <>
            <p className="cell-sub">You have it checked out until <b className="mono">{hm(st.active.until)}</b>. For safety it can't be shown again; give it back, or check it out again after it ends.</p>
            <div className="row-actions"><button type="button" className="btn" disabled={busy} onClick={() => void giveBack()}>Give it back now</button></div>
          </>
        ) : (
          <>
            <label className="rq-sec"><span className="rq-label"><span>Why do you need it?</span></span>
              <textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Console access during the outage, ticket #4821" /></label>
            <p className="cell-sub">Up to {st.maxMinutes >= 60 ? `${st.maxMinutes / 60} hour${st.maxMinutes === 60 ? "" : "s"}` : `${st.maxMinutes} minutes`}{st.grantEnds ? " or until your access ends" : ""}. Only one person can have it at a time. {st.willRotate ? "When your time is up, or you give it back, the password is changed." : "This resource's password is not changed automatically afterwards; your administrators are told."} Your reason and the time go into the audit log.</p>
            {st.waiting && <p className="ssh-err" role="alert">{st.waiting}</p>}
            <div className="row-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy || reason.trim().length < 10 || !!st.waiting} onClick={() => void take()}>{busy ? "Checking out…" : "Check out"}</button>
            </div>
          </>
        )}
        {error && st && <p className="ssh-err" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
