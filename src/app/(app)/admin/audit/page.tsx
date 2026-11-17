import Link from "next/link";
import { requireCapability } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listAuditEvents } from "@/lib/audit/query";
import { auditHistogram } from "@/lib/audit/histogram";
import { listAdminAuditEvents } from "@/lib/audit/admin-query";
import { chainKey, type ChainScope } from "@/lib/audit/chain-key";
import { resolvedExternalAnchorEnabled } from "@/lib/settings/platform";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { AccessLog, type AccessFilters, type AccessRowJSON, type SiteInfo, type UserInfo } from "./audit-table";
import { AdminLog, type AdminRowJSON } from "./admin-log";
import { IntegrityCard, type AnchorInfo, type ChainInfo } from "./integrity-card";
import { parseRange, resolveRange } from "./range";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log" };

const PAGE = 100;

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function chainInfo(scope: ChainScope, count: number, firstSeq: bigint | null): Promise<ChainInfo> {
  const head = await db.auditChainState.findUnique({ where: chainKey(scope), select: { lastSeq: true, verifiedAt: true, verifiedOk: true } });
  return {
    scope,
    count,
    firstSeq: firstSeq?.toString() ?? null,
    lastSeq: head && head.lastSeq > 0n ? head.lastSeq.toString() : null,
    verifiedAt: head?.verifiedAt?.toISOString() ?? null,
    verifiedOk: head?.verifiedOk ?? null,
  };
}

async function anchorInfo(admin: boolean): Promise<AnchorInfo> {
  const enabled = await resolvedExternalAnchorEnabled();
  if (!enabled) return { enabled, count: 0, last: null };
  const table = admin ? db.adminAuditAnchor : db.auditAnchor;
  const [count, last] = await Promise.all([
    (table as typeof db.auditAnchor).count(),
    (table as typeof db.auditAnchor).findFirst({ orderBy: { anchoredSeq: "desc" }, select: { anchoredSeq: true, genTime: true, tsaUrl: true } }),
  ]);
  return { enabled, count, last: last ? { anchoredSeq: last.anchoredSeq.toString(), genTime: last.genTime.toISOString(), tsaUrl: last.tsaUrl } : null };
}

function Tabs({ admin, access, adminCount }: { admin: boolean; access: number; adminCount: number }) {
  return (
    <nav className="au-tabs" aria-label="Audit log">
      <Link href="/admin/audit" className={admin ? "au-tab" : "au-tab on"} aria-current={admin ? undefined : "page"}>
        Access <span className="au-tab-n">{access.toLocaleString("en-US")}</span>
      </Link>
      <Link href="/admin/audit?tab=admin" className={admin ? "au-tab on" : "au-tab"} aria-current={admin ? "page" : undefined}>
        Admin actions <span className="au-tab-n">{adminCount.toLocaleString("en-US")}</span>
      </Link>
    </nav>
  );
}

async function AuditPageImpl({ searchParams }: { searchParams: Promise<SP> }) {
  await requireCapability("read_console");
  const sp = await searchParams;
  const admin = one(sp.tab) === "admin";

  const [ws, accessCount, adminCount, accessMin, adminMin] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.auditEvent.count(),
    db.adminAuditEvent.count(),
    db.auditEvent.aggregate({ _min: { seq: true } }),
    db.adminAuditEvent.aggregate({ _min: { seq: true } }),
  ]);
  const [chain, anchor] = await Promise.all([
    admin ? chainInfo("admin", adminCount, adminMin._min.seq) : chainInfo("access", accessCount, accessMin._min.seq),
    anchorInfo(admin),
  ]);

  const head = (
    <div className="page-head">
      <div>
        <div className="eyebrow">Operate{ws.slug ? ` · ${ws.slug}` : ""}</div>
        <h1>Audit log</h1>
        <p>
          {admin
            ? "Security-critical changes made by admins."
            : "Every request through a connector, with the access decision that was applied. Records are kept in a tamper-evident chain."}
        </p>
      </div>
      <div className="row-actions"><span id="au-head-actions" className="rs-head-actions" /></div>
    </div>
  );

  if (admin) {
    const { rows, total } = await listAdminAuditEvents({ limit: PAGE, offset: 0 });
    const initialRows: AdminRowJSON[] = rows.map((r) => ({ ...r, seq: r.seq?.toString() ?? null, timestamp: r.timestamp.toISOString() }));
    return (
      <main>
        {head}
        <Tabs admin access={accessCount} adminCount={adminCount} />
        <IntegrityCard chain={chain} anchor={anchor} />
        <AdminLog initialRows={initialRows} initialTotal={total} />
      </main>
    );
  }

  const range = parseRange(one(sp.range));
  const { from, to } = resolveRange(range, one(sp.from), one(sp.to), new Date());
  const decision = one(sp.decision);
  const filters: AccessFilters = {
    q: one(sp.q) ?? "",
    userId: one(sp.userId) ?? "",
    siteId: one(sp.siteId) ?? "",
    decision: decision === "ALLOW" || decision === "DENY" ? decision : "",
    kind: one(sp.kind) === "file" ? "file" : "",
    range,
    from: range === "custom" ? from.toISOString() : "",
    to: range === "custom" ? to.toISOString() : "",
  };
  const query = {
    q: filters.q || undefined, userId: filters.userId || undefined, siteId: filters.siteId || undefined,
    decision: filters.decision || undefined, kind: filters.kind || undefined, from, to,
  };

  const [users, sites, list, histogram] = await Promise.all([
    db.user.findMany({ select: { id: true, name: true, email: true, company: true, role: true }, orderBy: { name: "asc" } }),
    db.site.findMany({
      select: { id: true, name: true, accessMode: true, upstreamUrl: true, vaultCredential: { select: { protocol: true } } },
      orderBy: { name: "asc" },
    }),
    listAuditEvents({ ...query, limit: PAGE, offset: 0 }),
    auditHistogram({ ...query, limit: PAGE, offset: 0 }),
  ]);

  const userInfo: UserInfo[] = users.map((u) => ({ id: u.id, name: u.name, email: u.email, company: u.company, vendor: u.role === "VENDOR" }));
  const siteInfo: SiteInfo[] = sites.map((s) => {
    const remote = s.accessMode === "GATEWAY";
    const proto = remote ? (s.vaultCredential ? String(s.vaultCredential.protocol).toUpperCase() : "REMOTE") : (s.upstreamUrl ?? "").startsWith("http://") ? "HTTP" : "HTTPS";
    return { id: s.id, name: s.name, proto, remote };
  });
  const initialRows: AccessRowJSON[] = list.rows.map((r) => ({ ...r, timestamp: r.timestamp.toISOString() }));

  return (
    <main>
      {head}
      <Tabs admin={false} access={accessCount} adminCount={adminCount} />
      <IntegrityCard chain={chain} anchor={anchor} />
      <AccessLog users={userInfo} sites={siteInfo} initialRows={initialRows} initialTotal={list.total} initialHistogram={histogram} initialFilters={filters} />
    </main>
  );
}

export default async function AdminAuditPage(...args: Parameters<typeof AuditPageImpl>) {
  return withRequestTenant(() => AuditPageImpl(...args));
}
