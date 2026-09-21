"use client";

import { useState } from "react";

const MESSAGES: Record<string, string> = {
  slug_taken: "That address is already in use. Try another.",
  invalid_slug: "Use lowercase letters, digits and hyphens only.",
  reserved_slug: "That address is reserved. Please choose another.",
  invalid_limits: "Your plan could not be read. Contact support.",
  not_entitled: "This organisation is not entitled to Captivo Access.",
  entitlement_expired: "Your organisation's Captivo Access entitlement has lapsed. Renew it, then try again.",
  centre_unavailable: "We could not reach Captivo ID just now. Please try again in a few minutes.",
  already_provisioned: "Your organisation already has a Captivo Access workspace. Sign in there instead.",
  no_console_domain: "The console domain is not configured. Contact support.",
  unauthorized: "Your sign-in expired. Please sign in again.",
};

export function WorkspaceForm({ defaultSlug, domain }: { defaultSlug: string; domain: string }) {
  const [slug, setSlug] = useState(defaultSlug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the workspace exists but the centre never registered its console
  // origin. Sign-in to that console will not work until support finishes the
  // link, so this is shown INSTEAD of navigating: sending the person onward
  // into a console they cannot sign in to, with nothing said, is how the one
  // warning we were given got lost.
  const [unlinked, setUnlinked] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnlinked(null);
    const res = await fetch("/api/workspace/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const body = (await res.json().catch(() => ({}))) as { inviteUrl?: string; linked?: boolean; error?: string; consoleUrl?: string };
    if (res.ok && body.inviteUrl) {
      if (body.linked === false) {
        setBusy(false);
        setUnlinked(body.inviteUrl);
        return;
      }
      window.location.href = body.inviteUrl;
      return;
    }
    setBusy(false);
    const message = MESSAGES[body.error ?? ""] ?? "Something went wrong. Please try again.";
    setError(body.consoleUrl ? `${message} (${body.consoleUrl})` : message);
  }

  if (unlinked) {
    return (
      <div className="notice warn" role="status">
        <p>
          Your workspace was created, but signing in to it is not ready yet: we could not register
          its address with Captivo ID. Our support team has to finish connecting it — please contact
          them before inviting anyone.
        </p>
        <p>
          Keep this link to set up your admin account once it is connected:{" "}
          <a href={unlinked}>{unlinked}</a>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label className="field-label" htmlFor="ws-slug">Console address</label>
        <div className="row-actions">
          <input
            id="ws-slug"
            className="input"
            required
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            maxLength={63}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            autoComplete="off"
          />
          <span className="cell-sub">.{domain}</span>
        </div>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy || !slug}>
        {busy ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
