"use client";

import { useMemo, useState } from "react";
import type { CardVM } from "./portal-home";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { ResourceIcon } from "@/components/resource-icon";
import { SshCommandButton } from "./ssh-command";
import { DbConnectButton } from "./db-connect";

type TypeFilter = "all" | "web" | "remote";
const PAGE_SIZE = 25;

/**
 * The person's resources as a table: search and a type filter above, then each
 * resource with its access window (a bar that turns amber in its last fifth)
 * and an Open button.
 */
export function AccessCards({ cards }: { cards: CardVM[] }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return cards.filter((c) => {
      const remote = c.accessMode === "GATEWAY" || c.accessMode === "DATABASE";
      if (type === "web" && remote) return false;
      if (type === "remote" && !remote) return false;
      return !s || c.siteName.toLowerCase().includes(s) || c.hostname.toLowerCase().includes(s);
    });
  }, [cards, q, type]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pageCount - 1);
  const shown = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="ma-main">
      <div className="ma-tools">
        <label className="ma-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Search resources…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search resources" />
        </label>
        <div className="seg" role="group" aria-label="Type">
          {([["all", "All"], ["web", "Web"], ["remote", cards.some((c) => c.accessMode === "DATABASE") ? "Remote & databases" : "Remote desktop"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={type === k ? "seg-opt on" : "seg-opt"} aria-pressed={type === k} onClick={() => { setType(k); setPage(0); }}>{l}</button>
          ))}
        </div>
      </div>

      <div className={cards.some((c) => c.rdpHref || c.sshHref) ? "table-wrap ma-table ma-wide" : "table-wrap ma-table"}>
        <div className="ma-row ma-th" aria-hidden="true"><span>Resource</span><span>Access window</span><span /></div>
        {filtered.length === 0 ? (
          <div className="ma-empty">
            {cards.length === 0 ? "You don't have access to anything yet. Request access to a resource to get started." : "No resource matches your search."}
          </div>
        ) : shown.map((c) => {
          const remote = c.accessMode === "GATEWAY";
          const isDb = c.accessMode === "DATABASE";
          // A window with an end depletes; permanent and recurring ones do not.
          const timed = c.time.tone !== "schedule" && c.time.text !== "Permanent";
          const low = c.time.pct < 20;
          return (
            <div key={c.id} className={c.status === "active" && (c.rdpHref || c.sshHref) ? "ma-row has-rdp" : "ma-row"}>
              <span className="ma-res">
                <ResourceIcon name={c.tile.icon} color={c.tile.color} logoUrl={c.tile.logoUrl} logoBg={c.tile.logoBg} size={40} />
                <span className="ma-res-main">
                  <span className="ma-res-t"><b>{c.siteName}</b><span className={isDb ? "chip green" : remote ? "chip violet" : "chip"}>{isDb ? "DATABASE" : remote ? "REMOTE" : "WEB"}</span></span>
                  {c.hostname && <span className="mono t-muted ma-host">{c.hostname}</span>}
                </span>
              </span>
              <span className="ma-win">
                {c.status === "pending" ? <span className="pill warn">Pending approval</span>
                  : c.status === "off_hours" ? <span className="pill neutral">Outside its hours</span>
                  : !timed ? <span className="t-muted">{c.time.tone === "schedule" ? "⟳" : "∞"} {c.time.text}</span>
                  : (
                    <>
                      <span className={low ? "t-warn" : undefined}>{c.time.text}</span>
                      <span className="ma-bar"><span className={low ? "warn" : undefined} style={{ width: `${c.time.pct}%` }} /></span>
                    </>
                  )}
              </span>
              <span className="ma-act">
                {c.status === "active" && c.recorded && ((c.rdpHref && !c.rdpRecorded) || (c.sshHref && !c.sshRecorded)) && (
                  <span className="ma-norec" title={c.sshHref && !c.sshRecorded ? "Sessions opened with Open are recorded. Sessions in your own SSH app are not." : "Sessions opened with Open are recorded. Sessions in your own Remote Desktop app are not."}>not recorded</span>
                )}
                {c.status === "active" && c.rdpHref && (
                  <a className="btn sm" href={c.rdpHref} download title={c.rdpRecorded ? "Connect with your own Remote Desktop app. The file works for two minutes. Captivo signs you in, so leave any password prompt empty; the session is recorded and may be watched live." : `Connect with your own Remote Desktop app. The file works for two minutes; you sign in to the server yourself.${c.recorded ? " These sessions are not recorded." : ""}`}>.rdp file</a>
                )}
                {c.status === "active" && c.sshHref && <SshCommandButton href={c.sshHref} siteId={c.siteId} siteName={c.siteName} recorded={!!c.recorded} sshRecorded={!!c.sshRecorded} />}
                {isDb
                  ? (c.status === "active" && c.dbHref ? <DbConnectButton href={c.dbHref} siteName={c.siteName} /> : <span className="btn sm" aria-disabled="true" title={c.status === "active" ? "This database's connector needs an update first." : undefined}>Connect</span>)
                  : c.status === "active"
                  ? <a className="btn ink sm" href={c.href} target="_blank" rel="noopener noreferrer">Open ↗</a>
                  : <span className="btn sm" aria-disabled="true">Open</span>}
              </span>
            </div>
          );
        })}
      </div>

      {pageCount > 1 && (
        <div className="ma-pager">
          <button type="button" className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>← Prev</button>
          <span className="cell-sub">Page {cur + 1} of {pageCount}</span>
          <button type="button" className="btn sm" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
