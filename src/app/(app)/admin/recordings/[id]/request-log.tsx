"use client";

import { useMemo, useState } from "react";
import { fmt, useZone } from "../../audit/audit-zone";
import { clockOf } from "../rec-ui";
import type { KeystrokeEvent } from "./keystroke-timeline";

type Filter = "all" | "changes" | "errors";

const READS = /^(get|list|watch|GET|HEAD) /;

function took(ms: number | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : clockOf(ms);
}

/**
 * A Kubernetes session's recording: the API requests the user's kubectl made,
 * in order, with the namespace, the answer and how long it took. Request
 * bodies and what secrets hold were never stored; kubectl exec sessions are
 * recordings of their own.
 */
export function RequestLog({ events, state, startedAt }: { events: KeystrokeEvent[]; state: "loading" | "ok" | "unreachable"; startedAt: string }) {
  const zone = useZone();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(() => events.map((e, i) => {
    const status = Number(e.code ?? 0);
    return { ...e, i, status, change: e.kind === "query" && !READS.test(e.text), refused: (e.error ?? "").startsWith("Refused by Captivo") };
  }), [events]);
  const requests = rows.filter((r) => r.kind === "query");
  const changes = requests.filter((r) => r.change).length;
  const errors = requests.filter((r) => r.status >= 400).length;
  const at = (ms: number) => fmt(Date.parse(startedAt) + ms, zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (r.kind !== "query") return filter === "all" && !needle;
    if (filter === "changes" && !r.change) return false;
    if (filter === "errors" && r.status < 400) return false;
    return !needle || `${r.text} ${r.db ?? ""}`.toLowerCase().includes(needle);
  });

  if (state === "loading") return <div className="ql-empty">Reading the request log from the connector…</div>;
  if (state === "unreachable") return <div className="ql-empty"><b>The request log can&apos;t be read right now</b><span>Its connector is offline. The log is intact on it and shows here once it is back.</span></div>;

  return (
    <div className="ql">
      <div className="ql-head">
        <span><b>{requests.length}</b> request{requests.length === 1 ? "" : "s"}</span>
        {changes > 0 && <span className="t-warn"><b>{changes}</b> change{changes === 1 ? "" : "s"}</span>}
        {errors > 0 && <span className="t-bad"><b>{errors}</b> refused or failed</span>}
        <span className="ql-spacer" />
        <div className="seg" role="group" aria-label="Show">
          {([["all", "All"], ["changes", "Changes"], ["errors", "Refused & failed"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={filter === k ? "seg-opt on" : "seg-opt"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <input type="search" className="input ql-search" placeholder="Search requests…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search requests" />
      </div>
      {requests.length === 0 ? (
        <div className="ql-empty"><b>No requests</b><span>The session started but asked the cluster nothing beyond discovery.</span></div>
      ) : (
        <div className="table-wrap ql-wrap">
          <table className="table ql-table kl-table">
            <thead><tr><th>Time</th><th>Request</th><th>Namespace</th><th className="num">Answer</th></tr></thead>
            <tbody>
              {shown.map((r) => r.kind !== "query" ? (
                <tr key={r.i} className="ql-sys"><td className="mono">{at(r.atMs)}</td><td colSpan={3}>{r.text}</td></tr>
              ) : (
                <tr key={r.i} className={r.status >= 400 ? "ql-row bad" : r.change ? "ql-row warn" : "ql-row"}>
                  <td className="mono" title={`${clockOf(r.atMs)} into the session`}>{at(r.atMs)}</td>
                  <td>
                    <code className="ql-sql">{r.text}</code>
                    {r.refused && <span className="pill warn ql-tag">refused</span>}
                    {r.error && !r.refused && <span className="ql-err">{r.error}</span>}
                    {r.refused && <span className="ql-err">{r.error!.replace(/^Refused by Captivo: /, "")}</span>}
                  </td>
                  <td className="mono cell-sub">{r.db ?? ""}</td>
                  <td className="num mono">{r.status || "—"}<span className="cell-sub"> · {took(r.ms)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="rv-note">Requests as kubectl sent them; request bodies and what secrets hold are never stored. kubectl exec sessions are recorded separately, as terminals.</p>
    </div>
  );
}
