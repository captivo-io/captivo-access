"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ADOPT_MAX, adoptProblem, DISCOVER_MIN_CONNECTOR, DISCOVER_WINDOWS_MIN_CONNECTOR, type DiscoveredRow } from "@/lib/vault/discovery";

// Account discovery for one SSH resource (lib/vault/discovery.ts): which
// accounts the server has, and a way to take some over as resources whose
// password only Captivo knows.

type Scan = { accounts: DiscoveredRow[]; administrator: string; platform: "linux" | "windows" };
type Done = { created: { id: string; name: string; username: string }[]; refused: { name: string; reason: string }[]; nativeLeftOff: boolean };

function flags(a: DiscoveredRow, windows: boolean): string[] {
  const f: string[] = [];
  if (a.admin) f.push("administrator");
  if (a.noPass) f.push("no password");
  else if (a.locked) f.push(windows ? "disabled" : "password locked");
  else if (a.passAgeDays >= 0) f.push(a.passAgeDays === 0 ? "password changed today" : `password ${a.passAgeDays} days old`);
  if (!a.login) f.push("no shell");
  return f;
}

export function DiscoveryPanel({ siteId, host, windows }: { siteId: string; host: string; windows: boolean }) {
  const router = useRouter();
  const [scan, setScan] = useState<Scan | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<"scan" | "adopt" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/admin/sites/${siteId}/discovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: string; detail?: string }) | null;
    if (!res.ok) throw new Error(j?.detail ?? "Something went wrong. Try again.");
    return j as Record<string, unknown>;
  }

  async function doScan() {
    setBusy("scan"); setErr(null); setDone(null);
    try {
      setScan((await post({ action: "scan" })) as unknown as Scan);
      setPick(new Set()); setSure(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally { setBusy(null); }
  }

  async function adopt() {
    setBusy("adopt"); setErr(null);
    try {
      setDone((await post({ action: "adopt", accounts: [...pick] })) as unknown as Done);
      setPick(new Set()); setSure(false);
      router.refresh();
      setScan((await post({ action: "scan" })) as unknown as Scan);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally { setBusy(null); }
  }

  const toggle = (n: string) => setPick((cur) => { const x = new Set(cur); if (x.has(n)) x.delete(n); else if (x.size < ADOPT_MAX) x.add(n); return x; });

  return (
    <section className="rot" aria-labelledby="disc-h">
      <div className="rot-head">
        <div>
          <h2 id="disc-h">Accounts on this server</h2>
          <p className="cell-sub">Lists the accounts of <b className="mono">{host}</b> through the administrator account: who can sign in, who is an administrator, whose password is locked, empty or old. Nothing is changed by looking. Needs a connector on {windows ? DISCOVER_WINDOWS_MIN_CONNECTOR : DISCOVER_MIN_CONNECTOR} or later{windows ? " and the server's local accounts (SMB, port 445)" : ""}.</p>
        </div>
        <button type="button" className="btn" disabled={!!busy} onClick={() => void doScan()}>{busy === "scan" ? "Looking…" : scan ? "Scan again" : "Scan this server"}</button>
      </div>
      {err && <p className="rf-msg bad" role="status">{err}</p>}
      {done && (
        <div className="rf-msg ok" role="status">
          {done.created.length > 0 && <p>Created {done.created.length} resource{done.created.length === 1 ? "" : "s"}; Captivo is setting a new password on each now: {done.created.map((c, i) => <span key={c.id}>{i ? ", " : ""}<Link href={`/admin/sites/${c.id}/edit`}>{c.username}</Link></span>)}.</p>}
          {done.nativeLeftOff && <p>The native SSH client is off on the new resources: this resource&apos;s sessions are not recorded, and a native client needs a password the user knows.</p>}
          {done.refused.map((r) => <p key={r.name} className="t-muted">{r.name}: {r.reason}</p>)}
        </div>
      )}
      {scan && (
        <>
          <div role="group" aria-label="Accounts">
            {scan.accounts.map((a) => {
              const why = adoptProblem(a, scan.administrator, scan.platform);
              return (
                <label key={a.name} className="rf-row" style={{ cursor: why ? "default" : "pointer" }}>
                  <span className="rf-row-t">
                    <b className="mono">{a.name}</b>
                    <span className="cell-sub">{windows ? `RID ${a.uid}` : `uid ${a.uid} · ${a.shell || "no shell"}`}{flags(a, windows).length ? ` · ${flags(a, windows).join(" · ")}` : ""}{why ? ` — ${why}` : ""}</span>
                  </span>
                  <div className="rf-row-c"><input type="checkbox" aria-label={`Take over ${a.name}`} disabled={!!why || !!busy} checked={pick.has(a.name)} onChange={() => toggle(a.name)} /></div>
                </label>
              );
            })}
          </div>
          {pick.size > 0 && (
            <div className="rot-foot">
              <label className="rf-hint"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I understand: Captivo sets a new random password on {pick.size === 1 ? "this account" : `these ${pick.size} accounts`}, and anything else that signs in with the old password (a service, a script) stops working.</label>
              <button type="button" className="btn primary" disabled={!sure || !!busy} onClick={() => void adopt()}>{busy === "adopt" ? "Taking over…" : `Take over ${pick.size} account${pick.size === 1 ? "" : "s"}`}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
