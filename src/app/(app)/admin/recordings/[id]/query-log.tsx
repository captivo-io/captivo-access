"use client";

import { useMemo, useState } from "react";
import { riskyReason } from "@/lib/database/risky";
import { fmt, useZone } from "../../audit/audit-zone";
import { clockOf } from "../rec-ui";
import type { KeystrokeEvent } from "./keystroke-timeline";

type Filter = "all" | "errors" | "risky";

function duration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : clockOf(ms);
}

/**
 * A database session's recording: the statements it ran (the commands, for
 * Redis and MongoDB), in order, with when, how long, how many rows and whether
 * it failed. There is no screen to replay;
 * results and parameter values were never stored.
 */
export function QueryLog({ events, state, startedAt, engine }: { events: KeystrokeEvent[]; state: "loading" | "ok" | "unreachable"; startedAt: string; engine?: string | null }) {
  const zone = useZone();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(() => events.map((e, i) => ({ ...e, i, risky: e.kind === "query" ? riskyReason(e.text, engine) : null })), [events, engine]);
  const queries = rows.filter((r) => r.kind === "query");
  const errors = queries.filter((r) => r.error).length;
  const risky = queries.filter((r) => r.risky).length;
  const cmd = engine === "redis" || engine === "mongodb"; // a command log, not SQL
  // Wall-clock time: there is no replay to seek, and an investigation asks "when".
  const at = (ms: number) => fmt(Date.parse(startedAt) + ms, zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (r.kind !== "query") return filter === "all" && !needle;
    if (filter === "errors" && !r.error) return false;
    if (filter === "risky" && !r.risky) return false;
    return !needle || r.text.toLowerCase().includes(needle);
  });

  if (state === "loading") return <div className="ql-empty">Reading the query log from the connector…</div>;
  if (state === "unreachable") return <div className="ql-empty"><b>The query log can&apos;t be read right now</b><span>Its connector is offline. The log is intact on it and shows here once it is back.</span></div>;

  return (
    <div className="ql">
      <div className="ql-head">
        <span><b>{queries.length}</b> {cmd ? "command" : "statement"}{queries.length === 1 ? "" : "s"}</span>
        {errors > 0 && <span className="t-bad"><b>{errors}</b> failed</span>}
        {risky > 0 && <span className="t-warn"><b>{risky}</b> to review</span>}
        <span className="ql-spacer" />
        <div className="seg" role="group" aria-label="Show">
          {([["all", "All"], ["errors", "Failed"], ["risky", "To review"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={filter === k ? "seg-opt on" : "seg-opt"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <input type="search" className="input ql-search" placeholder={cmd ? "Search commands…" : "Search statements…"} value={q} onChange={(e) => setQ(e.target.value)} aria-label={cmd ? "Search commands" : "Search statements"} />
      </div>
      {queries.length === 0 ? (
        <div className="ql-empty"><b>{cmd ? "No commands" : "No statements"}</b><span>The session connected but ran no {cmd ? "commands" : "queries"}.</span></div>
      ) : (
        <div className="table-wrap ql-wrap">
          <table className="table ql-table">
            <thead><tr><th>Time</th><th>{engine === "redis" || engine === "mongodb" ? "Command" : "Statement"}</th><th>Database</th><th className="num">Took</th><th className="num">Rows</th></tr></thead>
            <tbody>
              {shown.map((r) => r.kind !== "query" ? (
                <tr key={r.i} className="ql-sys"><td className="mono">{at(r.atMs)}</td><td colSpan={4}>{r.text}</td></tr>
              ) : (
                <tr key={r.i} className={r.error ? "ql-row bad" : r.risky ? "ql-row warn" : "ql-row"} onClick={() => setOpen(open === r.i ? null : r.i)}>
                  <td className="mono" title={`${clockOf(r.atMs)} into the session`}>{at(r.atMs)}</td>
                  <td>
                    <code className={open === r.i ? "ql-sql open" : "ql-sql"}>{r.text || (cmd ? "(empty command)" : "(empty statement)")}</code>
                    {r.risky && <span className="pill warn ql-tag">{r.risky}</span>}
                    {r.error && <span className="ql-err">{r.code ? <span className="mono">{r.code}</span> : null} {r.error}</span>}
                  </td>
                  <td className="mono cell-sub">{r.db ?? ""}</td>
                  <td className="num mono">{duration(r.ms)}</td>
                  <td className="num mono">{r.rows ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="rv-note">{engine === "redis" ? "Each command with its first argument (usually the key); values and scripts are never stored." : engine === "mongodb" ? "Each command with its database and collection; filters, documents and results are never stored." : "Statements as the client sent them; password literals are hidden. Results and parameter values are never stored."}</p>
    </div>
  );
}
