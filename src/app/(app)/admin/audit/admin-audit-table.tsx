"use client";

import { useState } from "react";
import { adminActionLabel } from "@/lib/audit/admin-actions";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { AuditDrawer, DetailList } from "./audit-drawer";

export interface AdminAuditRowJSON {
  id: string;
  timestamp: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
}

export function AdminAuditTable({ rows }: { rows: AdminAuditRowJSON[] }) {
  const [open, setOpen] = useState<AdminAuditRowJSON | null>(null);
  if (rows.length === 0) return <div className="rs-none">No admin actions recorded yet.</div>;
  return (
    <>
      <div className="table-wrap au-table">
        <table className="table">
          <thead>
            <tr><th>Time</th><th>Admin</th><th>Action</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} tabIndex={0} className={open?.id === r.id ? "on" : undefined} onClick={() => setOpen(r)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r); }}>
                <td className="au-time"><LocalTime iso={r.timestamp} mode="short" /></td>
                <td className="au-who">{r.actorEmail ?? <span className="muted">System</span>}</td>
                <td><span className="rs-pill unknown">{adminActionLabel(r.action)}</span></td>
                <td className="au-sum">{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="au-foot"><span className="cell-sub">The latest {rows.length} admin action{rows.length === 1 ? "" : "s"}</span></div>
      </div>
      {open && (
        <AuditDrawer title={adminActionLabel(open.action)} onClose={() => setOpen(null)}>
          <p className="au-why">{open.summary}</p>
          <DetailList items={[
            ["Time", <LocalTime key="t" iso={open.timestamp} mode="full" />],
            ["Admin", open.actorEmail ?? "System"],
            ["Action", <span key="a" className="mono">{open.action}</span>],
            ["Target", open.targetType ?? "—"],
            ["Target ID", open.targetId ? <span key="ti" className="au-copyline"><span className="mono">{open.targetId}</span><CopyButton value={open.targetId} label="Copy" /></span> : "—"],
            ["Event ID", <span key="id" className="mono cell-sub">{open.id}</span>],
          ]} />
        </AuditDrawer>
      )}
    </>
  );
}
