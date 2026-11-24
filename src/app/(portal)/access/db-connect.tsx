"use client";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { mongoshCommand, mongoUrl, mysqlCommand, psqlCommand, redisCliCommand, redisUrl, sqlcmdCommand } from "@/lib/database/params";

type Ticket = { ticket: string; expiresAt: string; host: string; port: number; database: string; databases: string[]; recorded: boolean; engine?: "postgres" | "mysql" | "mssql" | "redis" | "mongodb" };
type Tab = "cli" | "fields" | "url";

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
      <button type="button" className="btn ink sm" onClick={() => setOpen(true)} title="Connect with your own database client (psql, mysql, SSMS, redis-cli, mongosh, DBeaver, DataGrip).">Connect</button>
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
  const [tab, setTab] = useState<Tab>("cli");
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
        if (j.engine === "mssql") setTab((cur) => (cur === "cli" ? "fields" : cur)); // SSMS users fill in fields first
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
  const my = t?.engine === "mysql";
  const ms = t?.engine === "mssql";
  const rd = t?.engine === "redis";
  const mg = t?.engine === "mongodb";
  const db = t ? encodeURIComponent(t.database) : "";
  const cmd = !t ? "" : ms ? sqlcmdCommand({ host: t.host, port: t.port, ticket: t.ticket, database: t.database }) : my ? mysqlCommand({ host: t.host, port: t.port, ticket: t.ticket, database: t.database }) : rd ? redisCliCommand(t) : mg ? mongoshCommand(t) : psqlCommand({ host: t.host, port: t.port, ticket: t.ticket, database: t.database });
  const uri = !t ? "" : ms ? `Server=tcp:${t.host},${t.port};${t.database ? `Database=${t.database};` : ""}User ID=${t.ticket};Password=x;Encrypt=True` : my ? `mysql://${t.ticket}@${t.host}:${t.port}/${db}?ssl-mode=REQUIRED` : rd ? redisUrl(t) : mg ? mongoUrl(t) : `postgresql://${t.ticket}@${t.host}:${t.port}/${db}?sslmode=require`;
  const jdbc = !t || rd || mg ? "" : ms ? `jdbc:sqlserver://${t.host}:${t.port};${t.database ? `databaseName=${t.database};` : ""}user=${t.ticket};password=x;encrypt=true` : my ? `jdbc:mysql://${t.host}:${t.port}/${db}?sslMode=REQUIRED&user=${t.ticket}` : `jdbc:postgresql://${t.host}:${t.port}/${db}?sslmode=require&user=${t.ticket}`;
  const tabs: [Tab, string][] = ms ? [["fields", "SSMS, Azure Data Studio, DBeaver"], ["cli", "sqlcmd"], ["url", "Connection string"]] : my ? [["cli", "mysql"], ["fields", "DBeaver, DataGrip, Workbench"], ["url", "URL"]] : rd ? [["cli", "redis-cli"], ["fields", "RedisInsight, DBeaver"], ["url", "URL"]] : mg ? [["cli", "mongosh"], ["fields", "Compass, Studio 3T"], ["url", "Connection string"]] : [["cli", "psql"], ["fields", "DBeaver, DataGrip, pgAdmin"], ["url", "URL"]];
  const fields: [string, string][] = !t ? [] : ms ? [["Server name", `${t.host},${t.port}`], ["Authentication", "SQL Server Authentication"], ["Login", t.ticket], ["Password", "x"], ...(t.database ? [["Database", t.database] as [string, string]] : []), ["Encryption", "Mandatory"]]
    : rd ? [["Host", t.host], ["Port", String(t.port)], ["User name", t.ticket], ["Password", "x"], ["TLS", "on"]]
    : mg ? [["Host", t.host], ["Port", String(t.port)], ["Authentication", "Username / Password"], ["Username", t.ticket], ["Password", "x"], ["Authentication mechanism", "PLAIN"], ["Authentication database", "$external"], ["TLS", "on"]]
    : [["Host", t.host], ["Port", String(t.port)], ...(t.database ? [["Database", t.database] as [string, string]] : []), ["User name", t.ticket], ["Password", ""], ["SSL", my ? "required" : "require"]];
  const plain = new Set(["Port", "SSL", "TLS", "Authentication", "Encryption", "Authentication mechanism"]);
  const subtitle = !t ? "With your own database client." : ms ? "With your own client: SSMS, Azure Data Studio, sqlcmd, DBeaver, DataGrip." : my ? "With your own client: mysql, DBeaver, DataGrip, MySQL Workbench." : rd ? "With your own client: redis-cli, RedisInsight, DBeaver, or an application's driver." : mg ? "With your own client: mongosh, MongoDB Compass, Studio 3T, or an application's driver." : "With your own client: psql, DBeaver, DataGrip, pgAdmin.";

  return (
    <Modal open onClose={onClose} title={`Connect to ${siteName}`} subtitle={subtitle} size="md">
      <div className="ssh-cmd">
        {error ? (
          <p className="ssh-err" role="alert">{error}</p>
        ) : !t ? (
          <p className="cell-sub">{busy ? "Getting connection details…" : ""}</p>
        ) : (
          <>
            <div className="seg" role="tablist" aria-label="Format">
              {tabs.map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "seg-opt on" : "seg-opt"} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {tab === "cli" && (
              <div className={expired ? "ssh-box expired" : "ssh-box"}><code>{cmd}</code>{!expired && <CopyButton value={cmd} />}</div>
            )}
            {tab === "fields" && (
              <dl className="db-fields">
                {fields.map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{v ? <><code>{v}</code>{!plain.has(k) && <CopyButton value={v} />}</> : <span className="cell-sub">leave it empty</span>}</dd></div>
                ))}
              </dl>
            )}
            {tab === "url" && (
              <>
                <div className="ssh-box"><code>{uri}</code><CopyButton value={uri} /></div>
                {jdbc && <div className="ssh-box"><code>{jdbc}</code><CopyButton value={jdbc} /></div>}
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
          <li>Captivo signs in to the database for you: you don&apos;t need its password. {ms || rd || mg ? "Your client wants a password: type anything (x)." : "If your client asks for one, leave it empty."}</li>
          {t && t.databases.length > 0 && <li>Databases you can open: <span className="mono">{t.databases.join(", ")}</span>.</li>}
          {ms && <li>Use SQL Server Authentication with encryption Mandatory (not Strict). Windows and Entra ID sign-in don&apos;t apply here.</li>}
          {rd && <li>Clients that send only a password (Redis before 6) take the ticket as the password. Redis 6 and later clients take it as the user name. TLS must be on. CONFIG, MONITOR, replication and ACL changes are not available.</li>}
          {mg && <li>The connection string has to ask for <span className="mono">authMechanism=PLAIN</span> with <span className="mono">authSource=$external</span> and TLS: that is how the ticket is passed, so a client left on its default sign-in is refused. Managing users and roles is not available.</li>}
          {my && <li>The MariaDB client takes <span className="mono">--ssl</span> instead of <span className="mono">--ssl-mode=REQUIRED</span>.</li>}
          <li>{t?.recorded ? (rd || mg ? "Every command you run is logged with its time and duration, not its values, filters or documents. Results are not stored." : "Every query you run is logged with its time and row count. Results are not stored.") : `Your connections are logged; the ${rd || mg ? "commands" : "queries"} are not.`} The connection ends when your access ends.</li>
          <li>The user name is yours alone: don&apos;t share it, and get new details instead of saving them for long.</li>
        </ul>
      </div>
    </Modal>
  );
}
