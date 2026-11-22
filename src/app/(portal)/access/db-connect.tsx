"use client";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { psqlCommand } from "@/lib/database/params";

type Ticket = { ticket: string; expiresAt: string; host: string; port: number; database: string; databases: string[]; recorded: boolean };
type Tab = "psql" | "fields" | "url";

const ERRORS: Record<string, string> = {
  forbidden: "Your access to this database isn't active right now.",
  connector_outdated: "This database's connector needs an update before you can connect.",
  vault_secret_reenter: "This database's saved account needs to be entered again by an administrator.",
  proxy_off: "Database connections aren't set up on this service yet.",
};

/**
 * "Connect" on a database resource: what the person's own client needs. The
 * user name is a ticket that starts connections for hours (until access or
 * this sign-in ends); Captivo signs in to the database for them.
 */
export function DbConnectButton({ href, siteName }: { href: string; siteName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ink sm" onClick={() => setOpen(true)} title="Connect with your own database client (psql, DBeaver, DataGrip, pgAdmin).">Connect</button>
      {open && <DbConnectModal href={href} siteName={siteName} onClose={() => setOpen(false)} />}
    </>
  );
}

function left(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function DbConnectModal({ href, siteName, onClose }: { href: string; siteName: string; onClose: () => void }) {
  const [t, setT] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("psql");
  const [now, setNow] = useState(() => Date.now());

  const fetchTicket = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as Partial<Ticket> & { error?: string };
      if (!res.ok || !j.ticket) {
        setT(null);
        setError(ERRORS[j.error ?? ""] ?? "Couldn't get connection details. Try again in a moment.");
      } else {
        setT(j as Ticket);
        setNow(Date.now());
      }
    } finally {
      setBusy(false);
    }
  }, [href]);

  useEffect(() => { void fetchTicket(); }, [fetchTicket]);
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  const expired = !!t && Date.parse(t.expiresAt) <= now;
  const until = t ? new Date(t.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const cmd = t ? psqlCommand({ host: t.host, port: t.port, ticket: t.ticket, database: t.database }) : "";
  const uri = t ? `postgresql://${t.ticket}@${t.host}:${t.port}/${encodeURIComponent(t.database)}?sslmode=require` : "";
  const jdbc = t ? `jdbc:postgresql://${t.host}:${t.port}/${encodeURIComponent(t.database)}?sslmode=require&user=${t.ticket}` : "";

  return (
    <Modal open onClose={onClose} title={`Connect to ${siteName}`} subtitle="With your own client: psql, DBeaver, DataGrip, pgAdmin." size="md">
      <div className="ssh-cmd">
        {error ? (
          <p className="ssh-err" role="alert">{error}</p>
        ) : !t ? (
          <p className="cell-sub">{busy ? "Getting connection details…" : ""}</p>
        ) : (
          <>
            <div className="seg" role="tablist" aria-label="Format">
              {([["psql", "psql"], ["fields", "DBeaver, DataGrip, pgAdmin"], ["url", "URL"]] as const).map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "seg-opt on" : "seg-opt"} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {tab === "psql" && (
              <div className={expired ? "ssh-box expired" : "ssh-box"}><code>{cmd}</code>{!expired && <CopyButton value={cmd} />}</div>
            )}
            {tab === "fields" && (
              <dl className="db-fields">
                {([["Host", t.host], ["Port", String(t.port)], ["Database", t.database], ["User name", t.ticket], ["Password", ""], ["SSL", "require"]] as const).map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{v ? <><code>{v}</code>{k !== "Port" && k !== "SSL" && <CopyButton value={v} />}</> : <span className="cell-sub">leave it empty</span>}</dd></div>
                ))}
              </dl>
            )}
            {tab === "url" && (
              <>
                <div className="ssh-box"><code>{uri}</code><CopyButton value={uri} /></div>
                <div className="ssh-box"><code>{jdbc}</code><CopyButton value={jdbc} /></div>
              </>
            )}
            <p className={expired ? "ssh-timer bad" : "ssh-timer"} aria-live="polite">
              {expired
                ? "These details have expired. Connections they started keep running while your access lasts."
                : <>Opens connections until <b className="mono">{until}</b> (in {left(Date.parse(t.expiresAt) - now)}), as long as your access and this sign-in last.</>}
            </p>
            {expired && <button type="button" className="btn primary" disabled={busy} onClick={() => void fetchTicket()}>Get new details</button>}
          </>
        )}
        <ul className="ssh-notes">
          <li>Captivo signs in to the database for you: you don&apos;t need its password. If your client asks for one, leave it empty.</li>
          {t && t.databases.length > 0 && <li>Databases you can open: <span className="mono">{t.databases.join(", ")}</span>.</li>}
          <li>{t?.recorded ? "Every query you run is logged with its time and row count. Results are not stored." : "Your connections are logged; the queries are not."} The connection ends when your access ends.</li>
          <li>The user name is yours alone: don&apos;t share it, and get new details instead of saving them for long.</li>
        </ul>
      </div>
    </Modal>
  );
}
