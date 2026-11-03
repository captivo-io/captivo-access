"use client";
import Link from "next/link";
import { useState } from "react";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { textMatch } from "@/lib/table/filter";
import { TerminateButton } from "@/app/(app)/_console/terminate-button";
import { RevokeAccessButton } from "@/app/(app)/_console/revoke-access-button";

import type { LiveRow } from "@/lib/live/rows";
export type { LiveRow };

export function LiveTable({ rows, canTerminate }: { rows: LiveRow[]; canTerminate: boolean }) {
  const [q, setQ] = useState("");
  if (rows.length === 0) return <div className="empty">No active sessions.</div>;
  const filtered = rows.filter((r) =>
    textMatch([r.userLabel, r.siteName, r.kind === "gateway" ? r.protocol : r.host], q),
  );
  return (
    <>
    <div className="filter-bar" style={{ marginBottom: ".8rem" }}>
      <div className="field field-search">
        <label className="field-label" htmlFor="live-q">Search</label>
        <input id="live-q" className="input" placeholder="user, resource, type…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
    </div>
    {filtered.length === 0 ? (
      <div className="empty">No matching sessions.</div>
    ) : (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Resource</th>
            <th>Type</th>
            <th>Started</th>
            <th>Watchers</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) =>
            r.kind === "gateway" ? (
              <tr key={r.sessionId}>
                <td>{r.userLabel}</td>
                <td>{r.siteName}</td>
                <td><span className="pill">{r.protocol.toUpperCase()}</span></td>
                <td className="cell-sub"><LocalTime iso={r.startedAt} /></td>
                <td className="cell-sub">{r.viewerCount}{r.controlled ? " · controlled" : ""}</td>
                <td className="row-actions">
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Link href={`/live/${r.sessionId}`} className="btn sm">Watch</Link>
                    {canTerminate && <TerminateButton sessionId={r.sessionId} grantId={r.grantId} vendorLabel={r.userLabel} className="btn sm danger" />}
                  </span>
                </td>
              </tr>
            ) : r.kind === "isolated" ? (
              <tr key={r.sessionId}>
                <td>{r.userLabel}</td>
                <td>{r.siteName}</td>
                <td><span className="pill">ISOLATED</span></td>
                <td className="cell-sub"><LocalTime iso={r.startedAt} /></td>
                <td className="cell-sub">{r.viewerCount}</td>
                <td className="row-actions">
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Link href={`/live/${r.sessionId}`} className="btn sm">Watch</Link>
                    {canTerminate && <TerminateButton sessionId={r.sessionId} grantId={r.grantId} vendorLabel={r.userLabel} className="btn sm danger" />}
                  </span>
                </td>
              </tr>
            ) : (
              <tr key={`web:${r.userLabel}:${r.siteName}:${r.host}`}>
                <td>{r.userLabel}</td>
                <td>{r.siteName}</td>
                <td><span className="pill">WEB APP</span></td>
                <td className="cell-sub"><LocalTime iso={r.startedAt} /></td>
                <td className="cell-sub">—</td>
                <td className="row-actions">
                  {r.grantId ? (
                    <RevokeAccessButton grantId={r.grantId} label={r.userLabel} />
                  ) : (
                    <span className="cell-sub">No active grant</span>
                  )}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
    )}
    </>
  );
}
