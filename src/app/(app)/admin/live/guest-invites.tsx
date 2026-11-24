"use client";
import { useCallback, useEffect, useState } from "react";

type Status = "waiting" | "joined" | "expired" | "removed";
interface Invite {
  id: string; email: string; canControl: boolean; untilSessionEnds: boolean; expiresAt: string;
  joinedAt: string | null; guestName: string | null; status: Status;
}

const STATUS: Record<Status, { text: string; tone: string }> = {
  waiting: { text: "Not joined yet", tone: "muted" },
  joined: { text: "Joined", tone: "ok" },
  expired: { text: "Expired", tone: "muted" },
  removed: { text: "Removed", tone: "muted" },
};

const ERRORS: Record<string, string> = {
  disabled: "Session invitations are turned off in Policy.",
  no_provider: "Guests sign in with Captivo ID or your own sign-in provider, and this workspace has neither.",
  not_found: "The session has ended.",
  not_invitable: "Guests can't be invited into this kind of session.",
  bad_email: "Enter a valid e-mail address.",
  too_many: "This session already has 5 invites open. Remove one first.",
};

/**
 * The watch window's guest list: invite someone from outside into this live
 * session (to watch, or to take control too), see who joined, remove them.
 */
export function GuestInvites({ sessionId, onToast }: { sessionId: string; onToast: (msg: string, ok?: boolean) => void }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [control, setControl] = useState(false);
  const [duration, setDuration] = useState<"15m" | "1h" | "session">("1h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; link: string; email: string; emailed: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/live/${sessionId}/invites`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json().catch(() => null)) as { invites?: Invite[]; unavailable?: string | null } | null;
    if (!j) return;
    setInvites(j.invites ?? []);
    setUnavailable(j.unavailable ?? null);
  }, [sessionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/admin/live/${sessionId}/invites`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, canControl: control, duration }),
    }).catch(() => null);
    setBusy(false);
    const j = (await r?.json().catch(() => null)) as { link?: string; emailed?: boolean; error?: string; invite?: Invite } | null;
    if (!r?.ok || !j?.link || !j.invite) {
      setError(ERRORS[j?.error ?? ""] ?? "The invite couldn't be created. Try again.");
      return;
    }
    const created = j.invite;
    setInvites((prev) => [...(prev ?? []), created]);
    setMade({ id: created.id, link: j.link, email: email.trim(), emailed: j.emailed === true });
    setEmail("");
    setControl(false);
    setOpen(false);
    void load();
  }

  async function remove(inv: Invite) {
    const r = await fetch(`/api/admin/live/${sessionId}/invites/${inv.id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) {
      onToast(inv.status === "joined" ? `${inv.guestName ?? inv.email} was removed from the session` : "Invite withdrawn");
      void load();
    } else {
      onToast("Couldn't remove the guest. Try again.", false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      onToast("Link copied");
    } catch {
      onToast("Couldn't copy. Select the link and copy it.", false);
    }
  }

  const shown = (invites ?? []).filter((i) => i.status === "waiting" || i.status === "joined");
  // The link is shown until it is used, withdrawn or out of time.
  const linkOpen = made && (invites ?? []).some((i) => i.id === made.id && i.status === "waiting");
  return (
    <section className="sv-guests" aria-label="Invited guests">
      <div className="sv-guests-head">
        <span className="kcell-k">Invited guests</span>
        {!unavailable && !open && <button type="button" className="btn sm" onClick={() => { setOpen(true); setError(null); }}>Invite someone</button>}
      </div>
      {unavailable && <p className="cell-sub sv-feednote">{ERRORS[unavailable]}</p>}
      {open && (
        <form className="sv-guest-form" onSubmit={create}>
          <label className="sv-gf-row">
            <span>E-mail</span>
            <input id="guest-email" className="input" type="email" required autoFocus placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="sv-gf-row">
            <span>They can</span>
            <select id="guest-control" className="input" value={control ? "control" : "watch"} onChange={(e) => setControl(e.target.value === "control")}>
              <option value="watch">Watch</option>
              <option value="control">Watch and take control</option>
            </select>
          </label>
          <label className="sv-gf-row">
            <span>For</span>
            <select id="guest-duration" className="input" value={duration} onChange={(e) => setDuration(e.target.value as typeof duration)}>
              <option value="15m">15 minutes</option>
              <option value="1h">1 hour</option>
              <option value="session">Until the session ends</option>
            </select>
          </label>
          <p className="cell-sub sv-feednote">They sign in with Captivo ID under this address and see only this session. You can take control back or remove them at any time.</p>
          {error && <p className="sv-gf-err" role="alert">{error}</p>}
          <div className="sv-gf-actions">
            <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn sm primary" disabled={busy || !email.trim()}>{busy ? "Creating…" : "Create invite"}</button>
          </div>
        </form>
      )}
      {made && linkOpen && (
        <div className="sv-guest-link">
          <span>{made.emailed ? `Sent to ${made.email}. You can also share the link:` : `Mail isn't set up, so send ${made.email} this link yourself:`}</span>
          <div className="sv-gl-row">
            <input id="guest-link" className="input mono" readOnly value={made.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
            <button type="button" className="btn sm" onClick={() => void copy(made.link)}>Copy</button>
          </div>
          <span className="cell-sub">It works once, on the browser it is opened in.</span>
        </div>
      )}
      {shown.length > 0 && (
        <ul className="sv-guest-list">
          {shown.map((i) => (
            <li key={i.id}>
              <span className={`rv-dot ${STATUS[i.status].tone}`} aria-hidden="true" />
              <span className="sv-gname">
                <b>{i.guestName ?? i.email}</b>
                <span className="cell-sub">{i.guestName ? `${i.email} · ` : ""}{STATUS[i.status].text} · {i.canControl ? "may take control" : "watch only"}</span>
              </span>
              <button type="button" className="btn sm ghost" onClick={() => void remove(i)}>{i.status === "joined" ? "Remove" : "Withdraw"}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
