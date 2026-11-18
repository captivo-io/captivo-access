"use client";

import { useState } from "react";

type PreviewResult = {
  ok: boolean;
  error?: string;
  found?: boolean;
  displayName?: string | null;
  groups?: string[];
  decision?: { deprovision: boolean; role: string | null; grantSiteIds: string[] };
};

const ROLE_LABEL: Record<string, string> = { ADMIN: "Admin", OPERATOR: "Operator", AUDITOR: "Auditor" };

/** "CN=Captivo-Admins,OU=Groups,DC=corp" → "Captivo-Admins" for the short list; the full DN stays in the title. */
function groupName(dn: string): string {
  const m = /^\s*CN=([^,]+)/i.exec(dn);
  return m ? m[1] : dn;
}

/** Card 3: 04 · Test resolve, a dry run of what a sign-in would do. */
export function ResolvePreview({ sites }: { sites: { id: string; name: string }[] }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "Deleted resource";

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/directory/resolve-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setResult(await res.json().catch(() => ({ ok: false, error: "Request failed." })));
    } catch {
      setResult({ ok: false, error: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  const can = !!result?.ok && !!result.found && !result.decision?.deprovision;
  const groups = result?.groups ?? [];

  return (
    <section className="dr-card">
      <div className="dr-card-head col">
        <span className="dr-sec">04 · VERIFY</span>
        <b className="dr-card-title">Test resolve</b>
        <span className="dr-card-sub">Preview what a user would get on sign-in. Nothing is changed.</span>
      </div>
      <form className="dr-resolve" onSubmit={run}>
        <input className="input mono" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@corp.local" aria-label="Email to resolve" required />
        <button type="submit" className="btn" disabled={busy}>{busy && <span className="dr-spin" aria-hidden="true" />}{busy ? "Resolving…" : "Resolve"}</button>
      </form>
      {result && !result.ok && <p className="notice error dr-resolve-err" role="alert">{result.error}</p>}
      {result?.ok && (
        <div className={can ? "dr-result ok" : "dr-result bad"} role="status">
          <b className="dr-result-h">{can ? "✓ Can sign in" : result.found ? "× No mapped group" : "× Not found in the directory"}</b>
          <div className="dr-kv"><span>User</span><span>{result.displayName || email}</span></div>
          <div className="dr-kv"><span>Groups</span>
            <span className="mono">{groups.length === 0 ? "—" : groups.map((g, i) => <span key={g} title={g}>{i ? ", " : ""}{groupName(g)}</span>)}</span>
          </div>
          {can && (
            <>
              <div className="dr-kv"><span>Role</span><span>{result.decision?.role ? ROLE_LABEL[result.decision.role] ?? result.decision.role : "Unchanged (no role group)"}</span></div>
              <div className="dr-kv"><span>Resources</span><span>{result.decision?.grantSiteIds.length ? result.decision.grantSiteIds.map(siteName).join(", ") : "—"}</span></div>
            </>
          )}
          <div className="dr-kv"><span>Result</span>
            <span>{can ? "Role and access are reconciled like this on sign-in." : "Sign-in is denied; a directory user is disabled."}</span>
          </div>
          <span className="dr-result-foot">Preview · no changes were made</span>
        </div>
      )}
    </section>
  );
}
