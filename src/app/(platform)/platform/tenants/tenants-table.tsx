"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { timeAgo } from "@/lib/format";

export interface TenantRowJSON {
  id: string; slug: string; name: string; status: string; plan: string; trialEndsAt: string | null; deletedAt: string | null; createdAt: string;
  users: number; admins: number; sites: number; connectors: number; connectorsOnline: number; requestsPending: number; lastActivity: string | null;
  dns: string; cert: string; certDaysLeft: number | null; cronStale: boolean; problems: string[];
}

type Filter = "all" | "active" | "suspended" | "problems" | "deleted";

export function TenantsTable({ rows }: { rows: TenantRowJSON[] }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "deleted") { if (!r.deletedAt) return false; }
      else if (r.deletedAt) return false;
      if (filter === "active" && r.status !== "ACTIVE") return false;
      if (filter === "suspended" && r.status !== "SUSPENDED") return false;
      if (filter === "problems" && r.problems.length === 0) return false;
      if (needle && !(r.name.toLowerCase().includes(needle) || r.slug.includes(needle))) return false;
      return true;
    });
  }, [rows, q, filter]);
  const counts = {
    all: rows.filter((r) => !r.deletedAt).length,
    active: rows.filter((r) => !r.deletedAt && r.status === "ACTIVE").length,
    suspended: rows.filter((r) => !r.deletedAt && r.status === "SUSPENDED").length,
    problems: rows.filter((r) => !r.deletedAt && r.problems.length > 0).length,
    deleted: rows.filter((r) => r.deletedAt).length,
  };
  const chip = (f: Filter, label: string) => (
    <button type="button" key={f} className={`btn sm ${filter === f ? "primary" : "ghost"}`} onClick={() => setFilter(f)}>{label} <span className="cell-sub">{counts[f]}</span></button>
  );
  const pill = (state: string, label: string, title?: string) => {
    const cls = state === "ok" ? "ok" : state === "expiring" ? "warn" : state === "unknown" ? "neutral" : "danger";
    return <span className={`pill ${cls}`} title={title}>{label}</span>;
  };
  return (
    <>
      <div className="filter-bar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search name or slug…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          {chip("all", "All")}{chip("active", "Active")}{chip("suspended", "Suspended")}{chip("problems", "Problems")}{chip("deleted", "Deleted")}
        </div>
      </div>
      {shown.length === 0 ? <div className="empty">No tenants match.</div> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tenant</th><th>Plan</th><th>Status</th><th>Users</th><th>Resources</th><th>Connectors</th><th>Health</th><th>Last activity</th><th>Created</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/platform/tenants/${r.id}`} className="link-button">{r.name}</Link><div className="cell-sub">{r.slug}</div></td>
                  <td>
                    <span className={`pill ${r.plan === "enterprise" ? "ok" : "neutral"}`}>{r.plan}</span>
                  </td>
                  <td>{r.deletedAt ? <span className="pill danger">Deleted</span> : <span className={`pill ${r.status === "ACTIVE" ? "ok" : "warn"}`}>{r.status === "ACTIVE" ? "Active" : "Suspended"}</span>}</td>
                  <td>{r.users}<div className="cell-sub">{r.admins} admin{r.admins === 1 ? "" : "s"}</div></td>
                  <td>{r.sites}{r.requestsPending ? <div className="cell-sub">{r.requestsPending} pending</div> : null}</td>
                  <td>{r.connectors === 0 ? <span className="cell-sub">—</span> : <span className={`pill ${r.connectorsOnline === r.connectors ? "ok" : r.connectorsOnline === 0 ? "danger" : "warn"}`}>{r.connectorsOnline}/{r.connectors} online</span>}</td>
                  <td>
                    {r.deletedAt ? <span className="cell-sub">—</span> : (
                      <span className="chips">
                        {pill(r.dns, "DNS")}
                        {pill(r.cert, r.cert === "expiring" && r.certDaysLeft !== null ? `TLS ${r.certDaysLeft}d` : "TLS")}
                        {r.cronStale ? <span className="pill warn" title="site-health heartbeat stale">Jobs</span> : null}
                      </span>
                    )}
                  </td>
                  <td className="cell-sub">{r.lastActivity ? <span title={r.lastActivity}>{timeAgo(new Date(r.lastActivity))}</span> : "never"}</td>
                  <td className="cell-sub"><LocalTime iso={r.createdAt} mode="date" /></td>
                  <td><Link href={`/platform/tenants/${r.id}`} className="btn sm">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
