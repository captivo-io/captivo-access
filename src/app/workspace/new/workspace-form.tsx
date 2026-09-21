"use client";

import { useState } from "react";

const MESSAGES: Record<string, string> = {
  slug_taken: "That address is already in use. Try another.",
  invalid_slug: "Use lowercase letters, digits and hyphens only.",
  invalid_limits: "Your plan could not be read. Contact support.",
  not_entitled: "This organisation is not entitled to Captivo Access.",
  no_console_domain: "The console domain is not configured. Contact support.",
  unauthorized: "Your sign-in expired. Please sign in again.",
};

export function WorkspaceForm({ defaultSlug, domain }: { defaultSlug: string; domain: string }) {
  const [slug, setSlug] = useState(defaultSlug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/workspace/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const body = (await res.json().catch(() => ({}))) as { inviteUrl?: string; error?: string };
    if (res.ok && body.inviteUrl) {
      window.location.href = body.inviteUrl;
      return;
    }
    setBusy(false);
    setError(MESSAGES[body.error ?? ""] ?? "Something went wrong. Please try again.");
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
