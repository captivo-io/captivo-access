import Link from "next/link";
import type { ReactNode } from "react";
import type { AlertLevel, PlatformAlert } from "@/lib/platform/overview";
import type { TenantHealth } from "@/lib/platform/health";

// Small shared server-renderable pieces for the platform console.

export function StatCard({ k, v, sub, tone, icon }: { k: string; v: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "danger"; icon?: ReactNode }) {
  return (
    <div className={`stat-card${tone ? ` ${tone}` : ""}`}>
      {icon ? <span className="stat-icon">{icon}</span> : null}
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub ? <div className="cell-sub">{sub}</div> : null}
    </div>
  );
}

export const PILL: Record<AlertLevel, string> = { danger: "danger", warn: "warn", info: "neutral" };

export function AlertList({ alerts, limit }: { alerts: PlatformAlert[]; limit?: number }) {
  const shown = limit ? alerts.slice(0, limit) : alerts;
  if (shown.length === 0) return <div className="empty">All clear — no alerts.</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <tbody>
          {shown.map((a, i) => (
            <tr key={i}>
              <td style={{ width: 1 }}><span className={`pill ${PILL[a.level]}`}>{a.level === "danger" ? "Action" : a.level === "warn" ? "Warning" : "Info"}</span></td>
              <td>{a.tenant ? <Link href={`/platform/tenants/${a.tenant.id}`} className="link-button">{a.tenant.name}</Link> : "Platform"}</td>
              <td className="cell-sub" style={{ whiteSpace: "normal" }}>{a.href ? <Link href={a.href} className="link-button">{a.text}</Link> : a.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusPill({ status, deletedAt }: { status: string; deletedAt?: Date | null }) {
  if (deletedAt) return <span className="pill danger">Deleted</span>;
  return <span className={`pill ${status === "ACTIVE" ? "ok" : "warn"}`}>{status === "ACTIVE" ? "Active" : "Suspended"}</span>;
}

export function PlanPill({ plan }: { plan: string }) {
  const cls = plan === "enterprise" ? "ok" : "neutral";
  return <span className={`pill ${cls}`}>{plan[0].toUpperCase() + plan.slice(1)}</span>;
}

export function HealthChips({ h }: { h: TenantHealth | null }) {
  if (!h) return <span className="cell-sub">—</span>;
  const dns = h.dns === "ok" ? "ok" : h.dns === "unknown" ? "neutral" : "danger";
  const cert = h.cert === "ok" ? "ok" : h.cert === "expiring" ? "warn" : h.cert === "unknown" ? "neutral" : "danger";
  return (
    <span className="chips">
      <span className={`pill ${dns}`} title={h.dnsAddresses.join(", ") || "no A record"}>DNS</span>
      <span className={`pill ${cert}`} title={h.certExpiresAt ? `expires ${h.certExpiresAt.toISOString().slice(0, 10)}` : h.cert}>TLS{h.certDaysLeft !== null && h.cert === "expiring" ? ` ${h.certDaysLeft}d` : ""}</span>
    </span>
  );
}

export function SectionHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card-head">
      <div><h2>{title}</h2>{sub ? <div className="sub">{sub}</div> : null}</div>
      {action}
    </div>
  );
}
