"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "../../_shell/local-time";
import { CopyButton } from "../../_shell/copy-button";
import { Modal } from "../../_shell/modal";

export type TokenRow = { id: string; name: string; prefix: string; sites: string[]; maxMinutes: number; ratePerMinute: number; autoApprove: boolean; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };
export type SiteChoice = { id: string; name: string; kind: string };

const ERRORS: Record<string, string> = {
  invalid_name: "Give it a name of 2 to 60 characters.",
  sites_required: "Pick at least one resource.",
  too_many_sites: "Pick at most 50 resources.",
  invalid_minutes: "The longest access must be between 5 minutes and 24 hours.",
  invalid_days: "The token's lifetime must be between 1 and 90 days.",
  invalid_rate: "Calls per minute must be between 10 and 600.",
  site_not_found: "One of the resources no longer exists. Reload the page.",
  limit_reached: "This workspace has reached its user limit; an agent counts as one.",
};

const minutesLabel = (m: number) => (m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

export function Agents({ tokens, sites, origin, limits }: { tokens: TokenRow[]; sites: SiteChoice[]; origin: string; limits: { defaultRate: number; minRate: number; maxRate: number; defaultMinutes: number; maxMinutes: number; defaultDays: number; maxDays: number } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [minutes, setMinutes] = useState(String(limits.defaultMinutes));
  const [days, setDays] = useState(String(limits.defaultDays));
  const [rate, setRate] = useState(String(limits.defaultRate));
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<TokenRow | null>(null);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/admin/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, siteIds: [...picked], maxMinutes: Number(minutes), days: Number(days), ratePerMinute: Number(rate), autoApprove: auto }) });
      const j = (await res.json().catch(() => null)) as { token?: string; error?: string; detail?: string } | null;
      if (!res.ok || !j?.token) { setErr(j?.detail ?? ERRORS[j?.error ?? ""] ?? "Something went wrong. Try again."); return; }
      setMade({ token: j.token, name });
      setOpen(false); setName(""); setPicked(new Set()); setAuto(false);
      router.refresh();
    } finally { setBusy(false); }
  }

  async function revoke(t: TokenRow) {
    setBusy(true);
    try {
      await fetch(`/api/admin/agents/${t.id}`, { method: "DELETE" });
      setRevoking(null);
      router.refresh();
    } finally { setBusy(false); }
  }

  const live = tokens.filter((t) => !t.revokedAt && new Date(t.expiresAt) > new Date());
  const api = `${origin || "https://YOUR-WORKSPACE-HOST"}/api/agent/v1`;

  return (
    <div className="rot" style={{ display: "grid", gap: 16 }}>
      <section aria-labelledby="ag-h">
        <div className="rot-head">
          <div><h2 id="ag-h">Tokens</h2><p className="cell-sub">{live.length} live. A token is shown once, when it is made.</p></div>
          <button type="button" className="btn primary" disabled={sites.length === 0} onClick={() => { setOpen(true); setErr(null); }}>New agent token</button>
        </div>
        {sites.length === 0 && <p className="rf-msg warn">Agents connect to SSH resources, TCP tunnels, databases, Kubernetes clusters, web applications and remote desktops, and there are none yet.</p>}
        {tokens.length === 0 ? <p className="cell-sub">No agent tokens yet.</p> : (
          <div role="list">
            {tokens.map((t) => {
              const off = !!t.revokedAt || new Date(t.expiresAt) <= new Date();
              return (
                <div key={t.id} role="listitem" className="rf-row">
                  <span className="rf-row-t">
                    <b>{t.name}</b> <span className="mono t-muted">{t.prefix}…</span>
                    <span className="cell-sub">{t.sites.join(", ")} · up to {minutesLabel(t.maxMinutes)} at a time · {t.ratePerMinute} calls/min · {t.autoApprove ? "approves its own requests" : "a person approves"} · {t.revokedAt ? "revoked" : off ? "expired" : <>expires <LocalTime iso={t.expiresAt} /></>} · {t.lastUsedAt ? <>last used <LocalTime iso={t.lastUsedAt} /></> : "never used"}</span>
                  </span>
                  <div className="rf-row-c">{!t.revokedAt && <button type="button" className="btn sm" onClick={() => setRevoking(t)}>Revoke</button>}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="ag-use">
        <h2 id="ag-use">How an agent uses it</h2>
        <p className="cell-sub">Send the token as <span className="mono">Authorization: Bearer …</span> to <span className="mono">{api}</span>.</p>
        <div className="rf-code"><pre className="mono">{`# what this token may ask for, and where each stands
curl -H "Authorization: Bearer $TOKEN" ${api}/me

# ask for 30 minutes on a resource, with a reason
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"siteId":"<id>","minutes":30,"reason":"Roll back release 4.2 (INC-1042)"}' ${api}/access

# once it is approved (status "active"): how to connect, by kind
# (an SSH command, a database client command and ticket, or a kubeconfig)
curl -X POST -H "Authorization: Bearer $TOKEN" ${api}/connect/<id>`}</pre><CopyButton value={`curl -H "Authorization: Bearer $TOKEN" ${api}/me`} /></div>
        <p className="cell-sub">An MCP client (an AI agent&apos;s host) can use the same operations at <span className="mono">{origin || "https://YOUR-WORKSPACE-HOST"}/api/agent/mcp</span> with the same bearer token.</p>
        <p className="cell-sub">A recorded SSH resource signs the agent in as its saved account: the agent holds no password or key, and the whole session is recorded. <span className="mono">GET {api}/access/&lt;id&gt;</span> says where a request stands.</p>
      </section>

      <Modal open={open} onClose={() => setOpen(false)} title="New agent token" subtitle="What it may ask for, and how far its own approval goes." size="md">
        <div className="rot-rec-form" style={{ display: "grid", gap: 12 }}>
          <label className="rq-sec"><span className="rq-label"><span>Name</span></span><input id="ag-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Release pipeline" maxLength={60} autoComplete="off" /></label>
          <fieldset className="rq-sec"><legend className="rq-label"><span>Resources it may ask for</span></legend>
            {sites.map((s) => (
              <label key={s.id} className="rf-row"><span className="rf-row-t"><b>{s.name}</b> <span className="cell-sub">{s.kind}</span></span>
                <div className="rf-row-c"><input type="checkbox" checked={picked.has(s.id)} onChange={() => setPicked((c) => { const x = new Set(c); if (x.has(s.id)) x.delete(s.id); else x.add(s.id); return x; })} aria-label={s.name} /></div></label>
            ))}
          </fieldset>
          <label className="rq-sec"><span className="rq-label"><span>Longest access per request (minutes)</span></span><input id="ag-min" className="input mono" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
          <label className="rq-sec"><span className="rq-label"><span>Token lifetime (days, at most {limits.maxDays})</span></span><input id="ag-days" className="input mono" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
          <label className="rq-sec"><span className="rq-label"><span>Calls per minute ({limits.minRate} to {limits.maxRate}; a tenth of it for requests and connections)</span></span><input id="ag-rate" className="input mono" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
          <div className="rf-row">
            <span className="rf-row-t"><b>Approves its own requests</b><span className="cell-sub">Off: every request waits for a person, who gets it on their phone. On: it is approved at once, only for the resources and minutes above, and the audit log says so.</span></span>
            <div className="rf-row-c"><button type="button" role="switch" aria-checked={auto} aria-label="Approves its own requests" className={auto ? "toggle on" : "toggle"} onClick={() => setAuto(!auto)}><span /></button></div>
          </div>
          {err && <p className="rf-msg bad" role="status">{err}</p>}
          <div className="rot-actions"><button type="button" className="btn sm" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn sm ink" disabled={busy || name.trim().length < 2 || picked.size === 0} onClick={() => void create()}>{busy ? "Making…" : "Make token"}</button></div>
        </div>
      </Modal>

      <Modal open={!!made} onClose={() => setMade(null)} title={`Token for ${made?.name ?? ""}`} subtitle="Copy it now. It is not shown again." size="md">
        {made && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="rf-code"><pre className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{made.token}</pre><CopyButton value={made.token} /></div>
            <p className="cell-sub">Keep it in the agent&apos;s secret store. Revoking it here stops it at once and ends the access it holds.</p>
            <div className="rot-actions"><button type="button" className="btn sm ink" onClick={() => setMade(null)}>Done</button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!revoking} onClose={() => setRevoking(null)} title={`Revoke ${revoking?.name ?? ""}?`} subtitle="It stops working now." size="sm">
        {revoking && (
          <div style={{ display: "grid", gap: 12 }}>
            <p className="cell-sub">Any access this agent holds ends too, and a session it has open is closed within a minute.</p>
            <div className="rot-actions"><button type="button" className="btn sm" onClick={() => setRevoking(null)}>Keep it</button><button type="button" className="btn sm ink" disabled={busy} onClick={() => void revoke(revoking)}>{busy ? "Revoking…" : "Revoke"}</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
