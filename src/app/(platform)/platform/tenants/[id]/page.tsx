import Link from "next/link";
import { notFound } from "next/navigation";
import { withRequestTenant } from "@/lib/tenant/request";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { getTenant, PURGE_AFTER_DAYS } from "@/lib/platform/tenants";
import { tenantStats } from "@/lib/platform/sql";
import { tenantHealth, healthProblems } from "@/lib/platform/health";
import { tenantOverview, tenantAdminAudit } from "@/lib/platform/tenant-admin";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { formatBytes, LIMIT_LABELS, CAPABILITY_LABELS, LIMIT_KEYS, CAPABILITY_KEYS } from "@/lib/platform/tenant-shape";
import { timeAgo } from "@/lib/format";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { StatCard, StatusPill, PlanPill, HealthChips, SectionHead } from "../../../_shell/ui";
import { TenantActions } from "./tenant-actions";
import { TenantSettingsForm } from "./tenant-settings-form";
import { DangerZone } from "./danger-zone";

export const dynamic = "force-dynamic";

const TABS = ["overview", "users", "resources", "connectors", "access", "audit", "settings", "danger"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", users: "Users", resources: "Resources", connectors: "Connectors", access: "Access", audit: "Audit", settings: "Settings", danger: "Danger zone" };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await withRequestTenant(async () => { await requirePlatformAdmin(); return getTenant(id); }).catch(() => null);
  return { title: t ? `${t.name} · Tenant` : "Tenant" };
}

export default async function TenantDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";

  const data = await withRequestTenant(async () => {
    await requirePlatformAdmin();
    const tenant = await getTenant(id);
    if (!tenant) return null;
    const [stats, health, ov, audit] = await Promise.all([
      tenantStats().then((m) => m.get(id) ?? null),
      !tenant.deletedAt && tenant.status === "ACTIVE" ? tenantHealth(tenant.slug).catch(() => null) : Promise.resolve(null),
      tenantOverview(id).catch(() => null),
      tab === "audit" ? tenantAdminAudit(id).catch(() => null) : Promise.resolve(null),
    ]);
    return { tenant, stats, health, ov, audit };
  });
  if (!data) notFound();
  const { tenant, stats, health, ov, audit } = data;
  const domain = consoleDomain();
  const consoleUrl = domain ? `https://${tenant.slug}.${domain}` : null;
  const problems = health ? healthProblems(health) : [];
  const href = (t: Tab) => (t === "overview" ? `/platform/tenants/${tenant.id}` : `/platform/tenants/${tenant.id}?tab=${t}`);

  return (
    <section>
      <p className="cell-sub" style={{ marginBottom: 8 }}><Link href="/platform/tenants" className="link-button">← Tenants</Link></p>
      <div className="page-head">
        <div>
          <div className="page-title-row">
            <h1>{tenant.name}</h1>
            <span className="chips"><StatusPill status={tenant.status} deletedAt={tenant.deletedAt} /><PlanPill plan={tenant.plan} /></span>
          </div>
          <p>
            <code>{tenant.slug}</code>
            {consoleUrl ? <> · <a href={consoleUrl} target="_blank" rel="noreferrer" className="link-button">{consoleUrl.replace("https://", "")} ↗</a></> : null}
            {" · "}created <LocalTime iso={tenant.createdAt.toISOString()} mode="date" />
            {tenant.deletedAt ? <> · <b>deleted {timeAgo(tenant.deletedAt)}, purged after {PURGE_AFTER_DAYS} days</b></> : null}
          </p>
        </div>
        <TenantActions tenant={{ id: tenant.id, slug: tenant.slug, status: tenant.status, deleted: !!tenant.deletedAt }} />
      </div>

      <div className="stat-grid">
        <StatCard k="Users" v={stats?.users ?? 0} sub={<>{stats?.admins ?? 0} admins · {stats?.vendors ?? 0} vendors</>} />
        <StatCard k="Resources" v={stats?.sites ?? 0} sub={<>{stats?.grantsActive ?? 0} active grants</>} />
        <StatCard k="Connectors" v={<>{stats?.connectorsOnline ?? 0}<span className="cell-sub"> / {stats?.connectors ?? 0}</span></>} tone={(stats?.connectors ?? 0) > 0 && (stats?.connectorsOnline ?? 0) === 0 ? "danger" : "ok"} sub="online" />
        <StatCard k="Pending requests" v={stats?.requestsPending ?? 0} tone={stats?.requestsPending ? "warn" : undefined} />
        <StatCard k="Recordings" v={formatBytes(stats?.recordingBytes ?? 0)} sub={<>{stats?.recordings ?? 0} sessions</>} />
        <StatCard k="Audit events" v={stats?.auditEvents ?? 0} sub={stats?.lastActivity ? <>last activity {timeAgo(stats.lastActivity)}</> : "no activity yet"} />
      </div>

      <div className="row-actions" style={{ flexWrap: "wrap", marginBottom: 16 }}>
        {TABS.map((t) => <Link key={t} href={href(t)} className={`btn sm ${tab === t ? "primary" : "ghost"}`}>{TAB_LABEL[t]}</Link>)}
      </div>

      {tab === "overview" && (
        <div className="dash-cols">
          <div className="card">
            <SectionHead title="Provisioning" sub={health ? <>probe host <code>{health.host}</code></> : "not probed (suspended or deleted)"} />
            {health ? (
              <div className="settings">
                <div className="setting"><div className="setting-main"><span className="setting-label">Namespace DNS &amp; TLS</span><div className="setting-hint">{problems.length ? problems.join(" · ") : "Wildcard record resolves to this server and the certificate covers it."}</div></div><div className="setting-ctl"><HealthChips h={health} /></div></div>
                <div className="setting"><div className="setting-main"><span className="setting-label">Certificate</span><div className="setting-hint">{health.certExpiresAt ? <>expires <LocalTime iso={health.certExpiresAt.toISOString()} mode="date" /> ({health.certDaysLeft} days)</> : "no certificate observed"}</div></div></div>
                <div className="setting"><div className="setting-main"><span className="setting-label">Background jobs</span><div className="setting-hint">{ov?.cronRuns.length ? ov.cronRuns.map((c) => `${c.job}: ${timeAgo(c.ranAt)}`).join(" · ") : "no cron run recorded yet"}</div></div></div>
              </div>
            ) : <div className="empty">Provisioning is only checked for active tenants.</div>}
          </div>
          <div className="card">
            <SectionHead title="Configuration" sub="What the tenant has set up." />
            <div className="settings">
              <div className="setting"><div className="setting-main"><span className="setting-label">Email (SMTP)</span><div className="setting-hint">{ov?.smtp ? `${ov.smtp.host ?? "—"} · ${ov.smtp.enabled ? "enabled" : "disabled"}${ov.smtp.lastVerifiedOk === false ? " · last test failed" : ""}` : "not configured (platform fallback applies if enabled)"}</div></div></div>
              <div className="setting"><div className="setting-main"><span className="setting-label">Single sign-on</span><div className="setting-hint">{ov?.sso?.enabled ? `enabled · ${ov.sso.issuer}` : "not enabled"}</div></div></div>
              <div className="setting"><div className="setting-main"><span className="setting-label">Recording policy</span><div className="setting-hint">mode {ov?.settings.recordingMode ?? "per_resource (default)"} · retention {ov?.settings.recordingRetentionDays ?? "∞"} days · keystrokes {ov?.settings.keystrokeLoggingMode ?? "per_resource"}</div></div></div>
              <div className="setting"><div className="setting-main"><span className="setting-label">Access policy</span><div className="setting-hint">max grant {ov?.settings.maxGrantDays ?? "∞"} days · audit retention {ov?.settings.auditRetentionDays ?? 730} days · justification {ov?.settings.requireRequestJustification === false ? "optional" : "required"}</div></div></div>
              <div className="setting"><div className="setting-main"><span className="setting-label">Limits &amp; capabilities</span><div className="setting-hint">{LIMIT_KEYS.filter((k) => tenant.limits[k] !== undefined).map((k) => `${LIMIT_LABELS[k]}: ${tenant.limits[k]}`).join(" · ") || "no limits"} · {CAPABILITY_KEYS.filter((k) => tenant.capabilities[k] !== undefined).map((k) => `${CAPABILITY_LABELS[k]}: ${tenant.capabilities[k] ? "on" : "off"}`).join(" · ") || "default capabilities"}</div></div></div>
              {tenant.notes ? <div className="setting"><div className="setting-main"><span className="setting-label">Operator notes</span><div className="setting-hint" style={{ whiteSpace: "pre-wrap" }}>{tenant.notes}</div></div></div> : null}
            </div>
          </div>
          <div className="card">
            <SectionHead title="Open invites" sub="Pending admin/user invitations." />
            {ov?.invites.filter((i) => !i.usedAt).length ? (
              <div className="table-wrap"><table className="table"><thead><tr><th>Email</th><th>Role</th><th>Expires</th></tr></thead><tbody>
                {ov.invites.filter((i) => !i.usedAt).map((i) => <tr key={i.id}><td>{i.email}</td><td className="cell-sub">{i.role}</td><td className="cell-sub"><LocalTime iso={i.expiresAt.toISOString()} mode="short" />{i.expiresAt < new Date() ? " · expired" : ""}</td></tr>)}
              </tbody></table></div>
            ) : <div className="empty">No open invites.</div>}
          </div>
          <div className="card">
            <SectionHead title="Recent grants & requests" />
            {ov?.grants.recent.length ? (
              <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Resource</th><th>State</th><th>Created</th></tr></thead><tbody>
                {ov.grants.recent.map((g) => {
                  const state = g.status !== "ACTIVE" ? g.status : g.requiresApproval && !g.approvedAt ? "PENDING" : g.endsAt && g.endsAt < new Date() ? "EXPIRED" : "ACTIVE";
                  const cls = state === "ACTIVE" ? "ok" : state === "PENDING" ? "warn" : state === "DENIED" || state === "REVOKED" ? "danger" : "neutral";
                  return <tr key={g.id}><td>{g.user}</td><td className="cell-sub">{g.site}</td><td><span className={`pill ${cls}`}>{state}</span></td><td className="cell-sub"><LocalTime iso={g.createdAt.toISOString()} mode="short" /></td></tr>;
                })}
              </tbody></table></div>
            ) : <div className="empty">No grants yet.</div>}
          </div>
        </div>
      )}

      {tab === "users" && (
        <div className="card">
          <SectionHead title="Users" sub={`${ov?.users.length ?? 0} accounts in this tenant.`} />
          {ov?.users.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Passkeys</th><th>Sessions</th><th>Created</th></tr></thead><tbody>
              {ov.users.map((u) => <tr key={u.id}><td>{u.name}<div className="cell-sub">{u.email}{u.directoryManaged ? " · directory" : ""}</div></td><td className="cell-sub">{u.role}</td><td><span className={`pill ${u.status === "ACTIVE" ? "ok" : "neutral"}`}>{u.status}</span></td><td className="cell-sub">{u.passkeys}</td><td className="cell-sub">{u.sessions}</td><td className="cell-sub"><LocalTime iso={u.createdAt.toISOString()} mode="date" /></td></tr>)}
            </tbody></table></div>
          ) : <div className="empty">No users yet — the first admin has not accepted the invite.</div>}
        </div>
      )}

      {tab === "resources" && (
        <div className="card">
          <SectionHead title="Resources" sub="Apps and hosts vendors can reach." />
          {ov?.sites.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Address</th><th>Mode</th><th>Connector</th><th>Health</th><th>Recording</th></tr></thead><tbody>
              {ov.sites.map((s) => <tr key={s.id}><td>{s.name}</td><td className="cell-sub">{s.hostname ?? "—"}{s.customDomain ? " · custom domain" : ""}</td><td className="cell-sub">{s.accessMode}</td><td className="cell-sub">{s.connectorName}</td><td>{s.probeOk === null ? <span className="pill neutral">unknown</span> : <span className={`pill ${s.probeOk ? "ok" : "danger"}`}>{s.probeOk ? "up" : "down"}</span>}</td><td className="cell-sub">{s.recordSessions ? "on" : "off"}</td></tr>)}
            </tbody></table></div>
          ) : <div className="empty">No resources yet.</div>}
        </div>
      )}

      {tab === "connectors" && (
        <div className="card">
          <SectionHead title="Connectors" sub="Outbound agents linking the tenant's networks." />
          {ov?.connectors.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Status</th><th>Last seen</th><th>Version</th><th>Address</th><th>Resources</th></tr></thead><tbody>
              {ov.connectors.map((c) => <tr key={c.id}><td>{c.name}</td><td><span className={`pill ${c.status === "ONLINE" ? "ok" : c.status === "PENDING" ? "neutral" : "danger"}`}>{c.status}</span></td><td className="cell-sub">{c.lastSeenAt ? timeAgo(c.lastSeenAt) : "never"}</td><td className="cell-sub">{c.version ?? "—"}</td><td className="cell-sub">{c.remoteAddr ?? "—"}</td><td className="cell-sub">{c.sites}</td></tr>)}
            </tbody></table></div>
          ) : <div className="empty">No connectors yet.</div>}
        </div>
      )}

      {tab === "access" && (
        <div className="card">
          <SectionHead title="Access" sub={<>{ov?.grants.active ?? 0} active · {ov?.grants.pending ?? 0} pending · {ov?.grants.revoked ?? 0} revoked · {ov?.grants.denied ?? 0} denied</>} />
          {ov?.grants.recent.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Resource</th><th>State</th><th>Ends</th><th>Created</th></tr></thead><tbody>
              {ov.grants.recent.map((g) => {
                const state = g.status !== "ACTIVE" ? g.status : g.requiresApproval && !g.approvedAt ? "PENDING" : g.endsAt && g.endsAt < new Date() ? "EXPIRED" : "ACTIVE";
                const cls = state === "ACTIVE" ? "ok" : state === "PENDING" ? "warn" : state === "DENIED" || state === "REVOKED" ? "danger" : "neutral";
                return <tr key={g.id}><td>{g.user}</td><td className="cell-sub">{g.site}</td><td><span className={`pill ${cls}`}>{state}</span></td><td className="cell-sub">{g.endsAt ? <LocalTime iso={g.endsAt.toISOString()} mode="short" /> : "permanent"}</td><td className="cell-sub"><LocalTime iso={g.createdAt.toISOString()} mode="short" /></td></tr>;
              })}
            </tbody></table></div>
          ) : <div className="empty">No grants or requests yet.</div>}
        </div>
      )}

      {tab === "audit" && (
        <div className="card">
          <SectionHead title="Admin audit" sub={audit ? <>{audit.total} events · chain {audit.integrity.ok ? "intact" : "BROKEN"}</> : "unavailable"} action={audit ? <span className={`pill ${audit.integrity.ok ? "ok" : "danger"}`}>{audit.integrity.ok ? "Integrity verified" : "Integrity failed"}</span> : null} />
          {audit && !audit.integrity.ok ? <p className="notice error">Chain verification failed: {audit.integrity.reason ?? "unknown"}{audit.integrity.brokenAtSeq ? ` at seq ${audit.integrity.brokenAtSeq}` : ""}.</p> : null}
          {audit?.rows.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th></tr></thead><tbody>
              {audit.rows.map((r) => <tr key={r.id}><td className="cell-sub"><LocalTime iso={r.timestamp.toISOString()} mode="short" /></td><td className="cell-sub">{r.actorEmail ?? "system"}</td><td className="cell-sub">{r.action}</td><td style={{ whiteSpace: "normal" }}>{r.summary}</td></tr>)}
            </tbody></table></div>
          ) : <div className="empty">No admin actions recorded yet.</div>}
        </div>
      )}

      {tab === "settings" && (
        <div className="card">
          <SectionHead title="Plan, limits & capabilities" sub="Commercial and technical envelope for this tenant. Limits are enforced when the tenant creates users, resources or connectors; capabilities gate features regardless of the deployment default." />
          <TenantSettingsForm tenant={{ id: tenant.id, name: tenant.name, plan: tenant.plan, trialEndsAt: tenant.trialEndsAt?.toISOString().slice(0, 10) ?? "", limits: tenant.limits, capabilities: tenant.capabilities, notes: tenant.notes ?? "" }} />
        </div>
      )}

      {tab === "danger" && <DangerZone tenant={{ id: tenant.id, slug: tenant.slug, name: tenant.name, deleted: !!tenant.deletedAt, status: tenant.status }} />}
    </section>
  );
}
