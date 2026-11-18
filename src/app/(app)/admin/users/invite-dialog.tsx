"use client";
import { useState } from "react";
import Link from "next/link";
import { PhoneInput } from "@/components/phone-input";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "@/lib/auth/roles";
import type { Role } from "@/generated/prisma/enums";
import { inviteTtlChoices, ttlLabel } from "@/lib/people/rows";
import { ROLE_INFO, roleTone } from "./people-view";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Vendors first: they are who most invites are for.
const ROLE_ORDER: Role[] = ["VENDOR", "OPERATOR", "ADMIN", "AUDITOR", "STAFF"];

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "name_email_role_required": return "Name, email and role are required.";
    case "email_registered": return "This email already has an account.";
    case "members_come_from_center": return "Organisation members are invited on the Captivo account page. Only vendors are invited here.";
    case "limit_reached": return "Your plan's user limit is reached. Ask your platform operator to raise it.";
    case "invalid_expiry": return "Pick how long the link works.";
    case "forbidden": return "Only admins can invite people.";
    default: return "Couldn't create the invite. Try again.";
  }
}

export function InviteDialogBody({ canEmail, vendorOnly, ttlHours, onClose, onCreated }: {
  /** A mail server will send it: the workspace's own, or the platform's fallback. */
  canEmail: boolean;
  vendorOnly: boolean;
  /** The policy's invite lifetime, preselected. */
  ttlHours: number;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const roles = ROLE_ORDER.filter((r) => ASSIGNABLE_ROLES.includes(r) && (!vendorOnly || r === "VENDOR"));
  const [role, setRole] = useState<Role>("VENDOR");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [ttl, setTtl] = useState(ttlHours);
  const [send, setSend] = useState(canEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string; emailed: boolean | null; email: string } | null>(null);

  const emailOk = EMAIL_RE.test(email.trim());
  const ready = name.trim() !== "" && emailOk;

  function reset() {
    setName(""); setEmail(""); setTouched(false); setCompany(""); setPhone(""); setError(null); setDone(null);
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), role, phone, company: company.trim(), sendEmail: canEmail && send, expiresInHours: ttl }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || !r?.link) { setError(errorMessage(r?.error)); return; }
      setDone({ link: r.link, emailed: r.emailed ?? null, email: email.trim() });
      onCreated(r.id);
    } catch {
      setError(errorMessage(undefined));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rq">
        <span className="iv-done" aria-hidden="true">✓</span>
        <b className="iv-done-t">Invite ready</b>
        <OneTimeLink link={done.link} emailed={done.emailed} email={done.email} onClose={onClose} onAnother={reset} />
      </div>
    );
  }

  return (
    <form className="rq" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
      <div className="rq-sec">
        <div className="rq-label"><span>Role</span></div>
        <div className="iv-roles" role="radiogroup" aria-label="Role">
          {roles.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "iv-role on" : "iv-role"} onClick={() => setRole(r)}>
              <span className="iv-role-n"><span className={`iv-dot ${roleTone(r)}`} aria-hidden="true" />{ROLE_LABELS[r]}</span>
              <span className="cell-sub">{ROLE_INFO[r]}</span>
            </button>
          ))}
        </div>
        {vendorOnly && <p className="rq-hint">Organisation members are invited on the Captivo account page.</p>}
      </div>

      <div className="iv-grid">
        <label className="rq-sec">
          <span className="rq-label"><span>Full name</span></span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className="rq-sec">
          <span className="rq-label"><span>Email</span></span>
          <input className={touched && email && !emailOk ? "input bad" : "input"} type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} autoComplete="off" aria-invalid={touched && !!email && !emailOk} />
        </label>
        <label className="rq-sec">
          <span className="rq-label"><span>Company <span className="t-muted iv-opt">(optional)</span></span></span>
          <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <div className="rq-sec">
          <span className="rq-label"><span>Phone <span className="t-muted iv-opt">(optional)</span></span></span>
          <PhoneInput onChange={setPhone} />
        </div>
      </div>

      <div className="rq-sec">
        <div className="rq-label"><span>Link works for</span></div>
        <div className="rq-pills" role="group" aria-label="Link works for">
          {inviteTtlChoices(ttlHours).map((h) => (
            <button key={h} type="button" className={ttl === h ? "fpill on" : "fpill"} aria-pressed={ttl === h} onClick={() => setTtl(h)}>
              {ttlLabel(h)}{h === ttlHours ? " · default" : ""}
            </button>
          ))}
        </div>
      </div>

      <div className={canEmail ? "rq-sec gd-rec" : "rq-sec gd-rec iv-locked"}>
        <div className="rq-row">
          <span className="rq-label-plain">
            Email the invite
            {canEmail ? (
              <span className="cell-sub">Sent to {email.trim() || "the address above"}. You still get the link.</span>
            ) : (
              <span className="cell-sub t-warn">Email is off. Copy the link and send it yourself, or set up <Link href="/admin/email">Email</Link>.</span>
            )}
          </span>
          <button type="button" role="switch" aria-checked={canEmail && send} aria-label="Email the invite" disabled={!canEmail}
            className={canEmail && send ? "toggle on" : "toggle"} onClick={() => setSend((v) => !v)}>
            <span />
          </button>
        </div>
      </div>

      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="rq-foot">
        <span className="rq-status t-muted">Invited as {ROLE_LABELS[role].toLowerCase()} · link works for {ttlLabel(ttl)}</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !ready}>{busy ? "Creating…" : "Create invite"}</button>
      </div>
    </form>
  );
}

/** The invite link, shown once, with Copy. */
export function OneTimeLink({ link, emailed, email, onClose, onAnother, label = "Invite link" }: {
  link: string; emailed: boolean | null; email: string; onClose: () => void; onAnother?: () => void; label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the field stays selectable */ }
  }
  return (
    <>
      <div className="rq-sec">
        <div className="rq-label"><span>{label}</span></div>
        <div className="iv-link">
          <input className="mono" readOnly value={link} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn primary sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <p className="iv-warn"><b>!</b>This link won&apos;t be shown again. Copy it now.</p>
        {emailed === true && <p className="rq-hint t-ok">Also emailed to {email}.</p>}
        {emailed === false && <p className="rq-hint t-warn">Couldn&apos;t email it to {email}. Copy the link and send it yourself.</p>}
      </div>
      <div className="rq-foot">
        <span className="rq-status" />
        {onAnother && <button type="button" className="btn" onClick={onAnother}>Another invite</button>}
        <button type="button" className="btn primary" onClick={onClose}>Close</button>
      </div>
    </>
  );
}
