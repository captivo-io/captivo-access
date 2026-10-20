"use client";

import { useState } from "react";
import { PhoneInput } from "@/components/phone-input";
import type { Role } from "@/generated/prisma/enums";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "@/lib/auth/roles";

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_body":
    case "name_email_role_required":
      return "Name, email, and role are required.";
    case "forbidden":
      return "Admin privileges are required for this action.";
    case "email_registered":
      return "This email already has an account.";
    case "members_come_from_center":
      return "This workspace belongs to a Captivo organisation: invite organisation members on the Captivo account page. Only vendors are invited here.";
    case "limit_reached":
      return "Your plan's user limit is reached — contact your platform operator to raise it.";
    default:
      return "Couldn't create the invite, please try again.";
  }
}

export function InviteForm({ smtpEnabled, vendorOnly }: { smtpEnabled: boolean; vendorOnly: boolean }) {
  // On a workspace that belongs to a Captivo organisation only vendors are invited here.
  const roles = vendorOnly ? ASSIGNABLE_ROLES.filter((r) => r === "VENDOR") : ASSIGNABLE_ROLES;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("VENDOR");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneKey, setPhoneKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [emailed, setEmailed] = useState<boolean | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLink(null);
    setCopied(false);
    setEmailed(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, role, phone, company, sendEmail: smtpEnabled && sendEmail }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.link) {
        setError(errorMessage(result?.error));
        return;
      }
      setLink(result.link);
      setEmailed(typeof result.emailed === "boolean" ? result.emailed : null);
      setName("");
      setEmail("");
      setRole("VENDOR");
      setCompany("");
      setPhone("");
      setPhoneKey((k) => k + 1);
    } catch {
      setError("Couldn't create the invite, please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label className="field-label" htmlFor="invite-name">
            Full name
          </label>
          <input
            id="invite-name"
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="invite-email">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="invite-company">
            Company <span className="hint">(optional)</span>
          </label>
          <input
            id="invite-company"
            type="text"
            className="input"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="organization"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="invite-phone">
            Phone <span className="hint">(optional)</span>
          </label>
          <PhoneInput key={phoneKey} id="invite-phone" onChange={setPhone} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="invite-role">
            Role
          </label>
          <select
            id="invite-role"
            className="select"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {roles.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {smtpEnabled && (
          <div className="field">
            <label className="field-label">
              <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /> Email the invite link to {email || "the address above"}
            </label>
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Creating…" : "Create invite"}
        </button>
      </form>

      {link && (
        <div role="status" className="notice">
          <p>This link is shown only once. Don&apos;t leave this page without saving it.</p>
          {emailed === true && <p className="notice success">Invite emailed to the address above.</p>}
          {emailed === false && <p className="notice error">Couldn&apos;t email it — copy the link below and send it manually.</p>}
          <code className="code secret">{link}</code>
          <button type="button" className="btn sm ghost" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
