"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { sealSecret } from "@/lib/vault/seal";
import { ELEVATE_BLOCK_TEXT, ELEVATE_MIN_CONNECTOR, type ElevateBlock } from "@/lib/vault/elevation";
import type { RotationStatus } from "@/lib/vault/rotation-status";

// Administrator rights during a session (lib/vault/elevation.ts) for one SSH
// resource: the switch, and the account that adds and removes the sudo entry.

const ERRORS: Record<string, string> = {
  ...ELEVATE_BLOCK_TEXT,
  invalid_reconcile_user: "Use a user name of letters, digits, . _ - and no spaces or quotes.",
  vault_key_changed: "None of this resource's connectors has a key yet. Reload the page and try again.",
  invalid_sealed_secret: "This browser can't seal the password for the connector. Use a current browser.",
};

export function ElevationPanel({ siteId, initial }: { siteId: string; initial: RotationStatus }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(initial.reconcile?.username ?? "root");
  const [kind, setKind] = useState<"PASSWORD" | "KEY">(initial.reconcile?.kind ?? "PASSWORD");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function put(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/sites/${siteId}/elevation`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const r = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) { setMsg({ tone: "bad", text: ERRORS[r?.error ?? ""] ?? "Something went wrong. Try again." }); return false; }
      const fresh = await fetch(`/api/admin/sites/${siteId}/elevation`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (fresh) setS(fresh);
      setMsg({ tone: "ok", text: "Saved." });
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function saveAccount() {
    if (!user.trim() || !secret) return;
    try {
      const target = { host: s.target.host, port: s.target.port, username: user.trim() };
      const seals = Object.fromEntries(await Promise.all(s.keys.map(async (k) => [k.key, await sealSecret(k.key, kind === "KEY" ? secret.trim() + "\n" : secret, target, "reconcile")] as const)));
      if (await put({ account: { username: user.trim(), kind, seals } })) { setSecret(""); setOpen(false); }
    } catch {
      setMsg({ tone: "bad", text: "This browser cannot seal secrets. Use a current browser." });
    }
  }

  const blocked: ElevateBlock | null = s.elevate ? null : !s.reconcile ? "elevate_needs_account" : null;

  return (
    <section className="rot" aria-labelledby="elev-h">
      <div className="rot-head">
        <div>
          <h2 id="elev-h">Administrator rights during sessions</h2>
          <p className="cell-sub">
            <b className="mono">{s.target.username}</b> stays an ordinary user. While someone has a recorded session on it, the connector gives it sudo, and takes it away when the last session ends. Needs connector {ELEVATE_MIN_CONNECTOR} or later and Linux.
          </p>
        </div>
        <span className={`rot-pill ${s.elevate ? "ok" : "off"}`}><i aria-hidden="true" />{s.elevate ? "On" : "Off"}</span>
      </div>

      <div className="rf-row">
        <span className="rf-row-t"><b>Give sudo during sessions</b><span className="cell-sub">Sessions are recorded, so what was done with the rights is on the recording. The session&apos;s banner says it has them.</span></span>
        <div className="rf-row-c"><button type="button" role="switch" aria-checked={s.elevate} aria-label="Give sudo during sessions" disabled={busy || (!s.elevate && !!blocked)} className={s.elevate ? "toggle on" : "toggle"} onClick={() => void put({ elevate: !s.elevate })}><span /></button></div>
      </div>

      <div className="rot-rec">
        <span className="rq-label"><span>Administrator account</span></span>
        <p className="cell-sub">{s.reconcile
          ? <>Signs in as <b className="mono">{s.reconcile.username}</b> ({s.reconcile.kind === "KEY" ? "SSH key" : "password"}) to add and remove the entry. It is the same account password rotation uses to reset passwords.{s.reconcile.missingFor.length ? ` ${s.reconcile.missingFor.join(", ")} has no copy yet: enter it again.` : ""}</>
          : "None yet. Root, or an account that can use sudo, on the server."}</p>
        {!open ? (
          <div className="rot-actions">
            <button type="button" className="btn sm" onClick={() => setOpen(true)}>{s.reconcile ? "Change" : "Add administrator account"}</button>
            {s.reconcile && !s.elevate && <button type="button" className="btn sm" disabled={busy} onClick={() => void put({ account: null })}>Remove</button>}
          </div>
        ) : (
          <div className="rot-rec-form">
            <label className="rq-sec"><span className="rq-label"><span>User</span></span>
              <input className="input mono" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></label>
            <div className="rq-sec"><span className="rq-label"><span>Signs in with</span></span>
              <div className="seg" role="radiogroup" aria-label="Signs in with">
                {(["PASSWORD", "KEY"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "seg-opt on" : "seg-opt"} onClick={() => setKind(k)}>{k === "KEY" ? "SSH key" : "Password"}</button>)}
              </div></div>
            <label className="rq-sec rot-wide"><span className="rq-label"><span>{kind === "KEY" ? "Private key" : "Password"}</span></span>
              {kind === "KEY"
                ? <textarea className="textarea mono" rows={4} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
                : <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />}</label>
            <p className="rf-hint rot-wide">Sealed in this browser to {s.keys.map((k) => k.name).join(", ")}. A sudo account without a password needs <span className="mono">NOPASSWD</span>, or its password here.</p>
            <div className="rot-actions rot-wide">
              <button type="button" className="btn sm" onClick={() => { setOpen(false); setSecret(""); }}>Cancel</button>
              <button type="button" className="btn sm ink" disabled={!user.trim() || !secret || busy} onClick={() => void saveAccount()}>{busy ? "Saving…" : "Save account"}</button>
            </div>
          </div>
        )}
      </div>
      {!s.elevate && blocked && <p className="rf-hint">{ELEVATE_BLOCK_TEXT[blocked]}</p>}
      {msg && <p className={`rf-msg ${msg.tone}`} role="status">{msg.text}</p>}
    </section>
  );
}
