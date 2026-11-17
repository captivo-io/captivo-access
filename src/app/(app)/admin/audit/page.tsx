import { requireCapability } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listAuditEvents } from "@/lib/audit/query";
import { resolvedExternalAnchorEnabled } from "@/lib/settings/platform";
import { AuditTable, type AuditRowJSON } from "./audit-table";
import { IntegrityPanel } from "./integrity-panel";
import Link from "next/link";
import { listAdminAuditEvents } from "@/lib/audit/admin-query";
import { AdminAuditTable, type AdminAuditRowJSON } from "./admin-audit-table";
import { AdminIntegrityPanel } from "./admin-integrity-panel";
import { withRequestTenant } from "@/lib/tenant/request";
import { auditSummary } from "@/lib/audit/summary";

function AuditTabs({ admin }: { admin: boolean }) {
  return (
    <div className="seg au-tabs" role="tablist" aria-label="Log">
      <Link href="/admin/audit" role="tab" aria-selected={!admin} className={admin ? "seg-opt" : "seg-opt on"}>Access requests</Link>
      <Link href="/admin/audit?tab=admin" role="tab" aria-selected={admin} className={admin ? "seg-opt on" : "seg-opt"}>Admin actions</Link>
    </div>
  );
}

function AuditHead({ admin, children }: { admin: boolean; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">Operate · {admin ? "admin actions" : "access requests"}</div>
        <h1>Audit</h1>
        <p>
          {admin
            ? "Security-critical changes made in this console: who changed what, and when."
            : "Every request through a connector, with the access decision that was applied. Select a row for the full record."}
        </p>
      </div>
      <div className="row-actions">{children}</div>
    </div>
  );
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit" };

const INITIAL_LIMIT = 50;

async function AdminAuditPageImpl({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireCapability("read_console");
  const { tab } = await searchParams;

  if (tab === "admin") {
    const { rows: adminRowsRaw } = await listAdminAuditEvents({ limit: 50, offset: 0 });
    const adminRows: AdminAuditRowJSON[] = adminRowsRaw.map((r) => ({
      id: r.id, timestamp: r.timestamp.toISOString(), actorEmail: r.actorEmail,
      action: r.action, targetType: r.targetType, targetId: r.targetId, summary: r.summary,
    }));
    const [adminAnchorEnabled, adminAnchorCount, adminLastAnchor] = await Promise.all([
      resolvedExternalAnchorEnabled(),
      db.adminAuditAnchor.count(),
      db.adminAuditAnchor.findFirst({
        orderBy: { anchoredSeq: "desc" },
        select: { anchoredSeq: true, genTime: true, tsaUrl: true },
      }),
    ]);
    const adminAnchor = {
      enabled: adminAnchorEnabled,
      count: adminAnchorCount,
      last: adminLastAnchor
        ? { anchoredSeq: adminLastAnchor.anchoredSeq.toString(), genTime: adminLastAnchor.genTime.toISOString(), tsaUrl: adminLastAnchor.tsaUrl }
        : null,
    };
    return (
      <main>
        <AuditHead admin />
        <AuditTabs admin />
        <AdminIntegrityPanel anchor={adminAnchor} />
        <AdminAuditTable rows={adminRows} />
      </main>
    );
  }

  const [users, sites, { rows, total }, summary] = await Promise.all([
    db.user.findMany({
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
    db.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    listAuditEvents({ limit: INITIAL_LIMIT, offset: 0 }),
    auditSummary(),
  ]);

  const [anchorEnabled, anchorCount, lastAnchor] = await Promise.all([
    resolvedExternalAnchorEnabled(),
    db.auditAnchor.count(),
    db.auditAnchor.findFirst({
      orderBy: { anchoredSeq: "desc" },
      select: { anchoredSeq: true, genTime: true, tsaUrl: true },
    }),
  ]);
  const anchor = {
    enabled: anchorEnabled,
    count: anchorCount,
    last: lastAnchor
      ? { anchoredSeq: lastAnchor.anchoredSeq.toString(), genTime: lastAnchor.genTime.toISOString(), tsaUrl: lastAnchor.tsaUrl }
      : null,
  };

  const initialRows: AuditRowJSON[] = rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp.toISOString(),
    userId: r.userId,
    userEmail: r.userEmail,
    userName: r.userName,
    company: r.company,
    siteId: r.siteId,
    siteName: r.siteName,
    host: r.host,
    method: r.method,
    path: r.path,
    status: r.status,
    bytesOut: r.bytesOut,
    decision: r.decision,
    reason: r.reason,
    clientIp: r.clientIp,
    userAgent: r.userAgent,
  }));

  return (
    <main>
      <AuditHead admin={false}><span id="au-head-actions" className="rs-head-actions" /></AuditHead>
      <AuditTabs admin={false} />
      <IntegrityPanel anchor={anchor} />
      <AuditTable users={users} sites={sites} initialRows={initialRows} initialTotal={total} summary={summary} />
    </main>
  );
}

export default async function AdminAuditPage(...args: Parameters<typeof AdminAuditPageImpl>) {
  return withRequestTenant(() => AdminAuditPageImpl(...args));
}

