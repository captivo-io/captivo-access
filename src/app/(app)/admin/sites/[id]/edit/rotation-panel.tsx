"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { openSealedSecret, revealKeyPair, sealSecret } from "@/lib/vault/seal";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { Modal } from "@/app/(app)/_shell/modal";
import type { RotationStatus } from "@/lib/vault/rotation-status";

// Password rotation for one resource (lib/vault/rotation.ts): when it rotates,
// the reconcile account that resets it, "Rotate now" and "Reveal".

const STATE: Record<string, [string, string]> = {
  ok: ["ok", "Rotated"],
  failed: ["bad", "Last rotation failed"],
  unknown: ["warn", "Being resolved"],
  out_of_sync: ["bad", "Changed outside Captivo"],
};

const ERRORS: Record<string, string> = {
  rotation_with_native: "Turn off the native RDP/SSH client first: a native client needs a password the user knows. Native SSH on a recorded resource works with rotation, as Captivo signs in for the user.",
  reason_required: "Say why you need it (at least 10 characters). The reason goes into the audit log.",
  invalid_reconcile_user: "Use a Linux user name (letters, digits, . _ -).",
  vault_key_changed: "None of this resource's connectors has a key yet. Reload the page and try again.",
  invalid_interval: "Pick an interval between 1 and 365 days.",
};

function errorText(r: { error?: string; detail?: string } | null): string {
  if (!r) return "Something went wrong. Try again.";
  return r.detail ?? ERRORS[r.error ?? ""] ?? "Something went wrong. Try again.";
}

export function RotationPanel({ siteId, siteName, initial }: { siteId: string; siteName: string; initial: RotationStatus }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [afterSession, setAfterSession] = useState(initial.afterSession);
  const [everyDays, setEveryDays] = useState<number | null>(initial.everyDays);
  const [verifyDaily, setVerifyDaily] = useState(initial.verifyDaily);
  const [recOpen, setRecOpen] = useState(false);
  const [recUser, setRecUser] = useState(initial.reconcile?.username ?? "root");
  const [recKind, setRecKind] = useState<"PASSWORD" | "KEY">(initial.reconcile?.kind ?? "PASSWORD");
  const [recSecret, setRecSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [reveal, setReveal] = useState<{ open: boolean; reason: string; password?: string; rotatesAt?: string | null }>({ open: false, reason: "" });
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const on = afterSession || everyDays !== null;
  const dirty = afterSession !== s.afterSession || everyDays !== s.everyDays || verifyDaily !== s.verifyDaily;
  const blocked = s.unsupported ?? (s.native && on ? ERRORS.rotation_with_native : null);

  async function refresh(): Promise<RotationStatus | null> {
    const r = await fetch(`/api/admin/sites/${siteId}/rotation`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (r) setS(r);
    return r;
  }

  async function save(extra: Record<string, unknown> = {}) {
    setBusy("save");
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/sites/${siteId}/rotation`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ afterSession, everyDays, verifyDaily, ...extra }),
      });
      const r = await res.json().catch(() => null);
      if (!res.ok) { setMsg({ tone: "bad", text: errorText(r) }); return false; }
      await refresh();
      setMsg({ tone: "ok", text: "Saved." });
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function saveReconcile() {
    if (!recUser.trim() || !recSecret) return;
    setBusy("reconcile");
    try {
      const target = { host: s.target.host, port: s.target.port, username: recUser.trim() };
      const seals = Object.fromEntries(await Promise.all(s.keys.map(async (k) => [k.key, await sealSecret(k.key, recKind === "KEY" ? recSecret.trim() + "\n" : recSecret, target, "reconcile")] as const)));
      if (await save({ reconcile: { username: recUser.trim(), kind: recKind, seals } })) { setRecSecret(""); setRecOpen(false); }
    } catch {
      setMsg({ tone: "bad", text: "This browser cannot seal secrets. Use a current browser." });
    } finally {
      setBusy(null);
    }
  }

  async function rotateNow() {
    setBusy("rotate");
    setMsg(null);
    const before = { rotatedAt: s.rotatedAt, state: s.state, detail: s.detail };
    const res = await fetch(`/api/admin/sites/${siteId}/rotation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rotate" }) });
    const r = await res.json().catch(() => null);
    if (!res.ok) { setBusy(null); setMsg({ tone: "bad", text: errorText(r) }); return; }
    setMsg({ tone: "ok", text: "Rotating… the connector is changing the password on the target." });
    let n = 0;
    poll.current = setInterval(async () => {
      n++;
      const cur = await refresh();
      const done = cur && (cur.rotatedAt !== before.rotatedAt || (!!cur.state && cur.state !== "ok" && (cur.state !== before.state || cur.detail !== before.detail)));
      if (done || n > 40) {
        if (poll.current) clearInterval(poll.current);
        setBusy(null);
        if (cur && cur.rotatedAt !== before.rotatedAt) setMsg({ tone: "ok", text: "The password was rotated." });
        else if (cur?.detail) setMsg({ tone: "bad", text: cur.detail });
        else setMsg({ tone: "bad", text: "Not rotated yet: a session may still be open on it. It rotates once that ends." });
        router.refresh();
      }
    }, 3000);
  }

  async function doReveal() {
    setBusy("reveal");
    try {
      const own = await revealKeyPair();
      const res = await fetch(`/api/admin/sites/${siteId}/rotation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reveal", reason: reveal.reason, publicKey: own.publicKey }) });
      const r = await res.json().catch(() => null);
      if (!res.ok) { setMsg({ tone: "bad", text: errorText(r) }); return; }
      const password = await openSealedSecret(own, r.sealed, r.target);
      setReveal({ open: true, reason: "", password, rotatesAt: r.rotatesAt });
      void refresh();
    } catch {
      setMsg({ tone: "bad", text: "The password could not be opened in this browser." });
    } finally {
      setBusy(null);
    }
  }

  const st = s.state ? STATE[s.state] : null;
  return (
    <section className="rot" aria-labelledby="rot-h">
      <div className="rot-head">
        <div>
          <h2 id="rot-h">Password rotation</h2>
          <p className="cell-sub">The connector sets a new random password on the target and keeps it sealed; nobody, Captivo included, sees it. Users keep signing in through the gateway.</p>
        </div>
        <span className={`rot-pill ${s.on ? (st?.[0] ?? "ok") : "off"}`}><i aria-hidden="true" />{s.on ? st?.[1] ?? "On" : "Off"}</span>
      </div>

      {s.unsupported ? <p className="rf-msg warn">{s.unsupported}</p> : (
        <>
          <dl className="rot-facts">
            <div><dt>Account</dt><dd className="mono">{s.target.username}@{s.target.host}{s.method === "ad" ? " · Active Directory" : " · SSH"}</dd></div>
            <div><dt>Last rotated</dt><dd>{s.rotatedAt ? <LocalTime iso={s.rotatedAt} /> : "Never"}</dd></div>
            <div><dt>Next</dt><dd>{s.dueAt ? <LocalTime iso={s.dueAt} /> : s.afterSession ? "After the next session" : "—"}</dd></div>
            {s.verifyDaily && <div><dt>Last checked</dt><dd>{s.verifiedAt ? <LocalTime iso={s.verifiedAt} /> : "Not yet"}</dd></div>}
          </dl>
          {s.detail && s.state !== "ok" && <p className={s.state === "unknown" ? "rf-msg warn" : "rf-msg bad"}>{s.detail}{s.state === "unknown" ? " Both passwords are kept until the next attempt finds out which one the target uses." : ""}</p>}
          {s.state === "ok" && s.detail && <p className="rf-msg ok">{s.detail}</p>}
          {s.waiting && <p className="rf-msg warn">{s.waiting}</p>}

          <div className="rf-row">
            <span className="rf-row-t"><b>After each session</b><span className="cell-sub">A minute after the last session on this resource ends. While someone is still connected it waits.</span></span>
            <div className="rf-row-c"><button type="button" role="switch" aria-checked={afterSession} aria-label="After each session" className={afterSession ? "toggle on" : "toggle"} onClick={() => setAfterSession(!afterSession)}><span /></button></div>
          </div>
          <div className="rf-row">
            <span className="rf-row-t"><b>On a schedule</b><span className="cell-sub">Also rotates when nobody used it.</span></span>
            <div className="rf-row-c">
              <div className="rf-pills" role="radiogroup" aria-label="Schedule">
                {([[null, "Off"], [7, "7 days"], [30, "30 days"], [90, "90 days"]] as const).map(([v, l]) => (
                  <button key={l} type="button" role="radio" aria-checked={everyDays === v} className={everyDays === v ? "rf-pill on" : "rf-pill"} onClick={() => setEveryDays(v)}>{l}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="rf-row">
            <span className="rf-row-t"><b>Check it daily</b><span className="cell-sub">Signs in once a day with the saved password. If it no longer works, someone changed it outside Captivo: you are told{s.method === "linux" ? (s.reconcile ? " and the reconcile account resets it" : "") : s.directoryReset ? " and the reset account resets it" : ""}.</span></span>
            <div className="rf-row-c"><button type="button" role="switch" aria-checked={verifyDaily} aria-label="Check it daily" className={verifyDaily ? "toggle on" : "toggle"} onClick={() => setVerifyDaily(!verifyDaily)}><span /></button></div>
          </div>
          {on && !s.on && <p className="rf-msg warn">Anything else that signs in with this account&apos;s password (a service, a scheduled task, a script) stops working after the first rotation.</p>}
          {blocked && <p className="rf-msg bad">{blocked}</p>}

          <div className="rot-rec">
            <span className="rq-label"><span>{s.method === "ad" ? "Password reset account" : "Reconcile account"}</span><span className="t-muted rf-opt">(recommended)</span></span>
            {s.method === "ad" ? (
              s.directoryReset ? (
                <p className="cell-sub"><b className="mono">{s.directoryReset.username}</b> resets it when the account cannot change its own password (Active Directory allows one change a day by default) or when it no longer matches.{s.directoryReset.missingFor.length ? ` ${s.directoryReset.missingFor.join(", ")} has no copy yet; it is copied within a few minutes.` : ""} <Link href="/admin/directory">Directory settings</Link></p>
              ) : (
                <p className="cell-sub">None yet. Active Directory lets an account change its own password once a day by default, so “after each session” needs an account with the Reset password right. <Link href="/admin/directory">Add it in Directory settings</Link>.</p>
              )
            ) : (
              <>
                <p className="cell-sub">{s.reconcile
                  ? <>Signs in as <b className="mono">{s.reconcile.username}</b> ({s.reconcile.kind === "KEY" ? "SSH key" : "password"}) to reset the password when the account cannot change its own or when it no longer matches.{s.reconcile.missingFor.length ? ` ${s.reconcile.missingFor.join(", ")} has no copy yet; it is copied within a few minutes.` : ""}</>
                  : "Optional: root, or a sudo account, on this server. Used only when the account cannot change its own password or when it no longer matches; never for a session."}</p>
                {!recOpen ? (
                  <div className="rot-actions">
                    <button type="button" className="btn sm" onClick={() => setRecOpen(true)}>{s.reconcile ? "Change" : "Add reconcile account"}</button>
                    {s.reconcile && <button type="button" className="btn sm" disabled={!!busy} onClick={() => void save({ reconcile: null })}>Remove</button>}
                  </div>
                ) : (
                  <div className="rot-rec-form">
                    <label className="rq-sec"><span className="rq-label"><span>User</span></span>
                      <input className="input mono" value={recUser} onChange={(e) => setRecUser(e.target.value)} autoComplete="off" /></label>
                    <div className="rq-sec"><span className="rq-label"><span>Signs in with</span></span>
                      <div className="seg" role="radiogroup" aria-label="Signs in with">
                        {(["PASSWORD", "KEY"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={recKind === k} className={recKind === k ? "seg-opt on" : "seg-opt"} onClick={() => setRecKind(k)}>{k === "KEY" ? "SSH key" : "Password"}</button>)}
                      </div></div>
                    <label className="rq-sec rot-wide"><span className="rq-label"><span>{recKind === "KEY" ? "Private key" : "Password"}</span></span>
                      {recKind === "KEY"
                        ? <textarea className="textarea mono" rows={4} value={recSecret} onChange={(e) => setRecSecret(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
                        : <input className="input mono" type="password" value={recSecret} onChange={(e) => setRecSecret(e.target.value)} autoComplete="new-password" />}</label>
                    <p className="rf-hint rot-wide">Sealed in this browser to {s.keys.map((k) => k.name).join(", ")}. A user other than root needs sudo for chpasswd{recKind === "KEY" ? " without a password" : ""}.</p>
                    <div className="rot-actions rot-wide">
                      <button type="button" className="btn sm" onClick={() => { setRecOpen(false); setRecSecret(""); }}>Cancel</button>
                      <button type="button" className="btn sm ink" disabled={!recUser.trim() || !recSecret || !!busy} onClick={() => void saveReconcile()}>{busy === "reconcile" ? "Saving…" : "Save account"}</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="rot-foot">
            <div className="rot-actions">
              <button type="button" className="btn" disabled={!!busy || !!s.waiting || s.native} onClick={() => void rotateNow()}>{busy === "rotate" ? "Rotating…" : "Rotate now"}</button>
              {(s.on || s.rotatedAt) && <button type="button" className="btn" disabled={!!busy || !!s.waiting} onClick={() => setReveal({ open: true, reason: "" })}>Reveal password</button>}
            </div>
            <button type="button" className="btn primary" disabled={!dirty || !!busy || !!blocked} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save rotation"}</button>
          </div>
          {msg && <p className={`rf-msg ${msg.tone}`} role="status">{msg.text}</p>}
          {(s.on || s.rotatedAt) && (
            <p className="rf-hint">If Captivo cannot be reached, read it on the host of the connector that rotated it{s.rotatedBy ? <> (<b>{s.rotatedBy}</b>)</> : ""}: <code>docker exec access-connector connector show-password &quot;{siteName}&quot;</code></p>
          )}
        </>
      )}

      {reveal.open && (
        <Modal open title="Reveal the saved password" size="sm" onClose={() => setReveal({ open: false, reason: "" })}>
          {reveal.password ? (
            <div className="rot-modal">
              <p className="cell-sub">For <span className="mono">{s.target.username}@{s.target.host}</span>. Opened in this browser only; this look is in the audit log.{reveal.rotatesAt ? <> It rotates again at <LocalTime iso={reveal.rotatesAt} />.</> : ""}</p>
              <div className="rot-secret mono">{reveal.password}</div>
              <div className="rot-actions">
                <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(reveal.password ?? "")}>Copy</button>
                <button type="button" className="btn primary" onClick={() => setReveal({ open: false, reason: "" })}>Done</button>
              </div>
            </div>
          ) : (
            <div className="rot-modal">
              <p className="cell-sub">The connector seals it to a key this page just made, so only this browser can open it. The reason is written to the audit log{s.on ? ", and the password rotates again two hours later" : ""}.</p>
              <label className="rq-sec"><span className="rq-label"><span>Reason</span></span>
                <textarea className="textarea" rows={2} value={reveal.reason} onChange={(e) => setReveal({ ...reveal, reason: e.target.value })} placeholder="e.g. Console access during the network outage, ticket #4821" /></label>
              {msg?.tone === "bad" && <p className="rf-msg bad">{msg.text}</p>}
              <div className="rot-actions">
                <button type="button" className="btn" onClick={() => setReveal({ open: false, reason: "" })}>Cancel</button>
                <button type="button" className="btn primary" disabled={reveal.reason.trim().length < 10 || !!busy} onClick={() => void doReveal()}>{busy === "reveal" ? "Opening…" : "Reveal"}</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
