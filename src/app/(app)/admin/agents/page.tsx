import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { AGENT_KIND_LABEL, agentKind } from "@/lib/agent/sites";
import { AGENT_DEFAULT_DAYS, AGENT_DEFAULT_MINUTES, AGENT_MAX_DAYS, AGENT_MAX_MINUTES } from "@/lib/agent/tokens";
import { Agents, type TokenRow, type SiteChoice } from "./agents";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

async function AgentsPageImpl() {
  await requireAdmin();
  const [tokens, sites, ws] = await Promise.all([
    db.apiToken.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, prefix: true, siteIds: true, maxMinutes: true, autoApprove: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true } }),
    db.site.findMany({ select: { id: true, name: true, accessMode: true, recordSessions: true, vaultCredential: { select: { protocol: true } } }, orderBy: { name: "asc" } }),
    workspaceView().catch(() => ({ slug: null as string | null, origin: "" })),
  ]);
  const choices: SiteChoice[] = sites.flatMap((s) => { const k = agentKind(s); return k ? [{ id: s.id, name: s.name, kind: AGENT_KIND_LABEL[k] }] : []; });
  const names = new Map(sites.map((s) => [s.id, s.name]));
  const rows: TokenRow[] = tokens.map((t) => ({
    id: t.id, name: t.name, prefix: t.prefix, sites: t.siteIds.map((id) => names.get(id) ?? "(deleted)"), maxMinutes: t.maxMinutes, autoApprove: t.autoApprove,
    expiresAt: t.expiresAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null, revokedAt: t.revokedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(),
  }));
  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Identity &amp; access{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Agents</h1>
          <p>Tokens for scripts, pipelines and AI agents. An agent asks for a resource for a few minutes with a reason; a person approves it (or the token approves its own, within its limits); the session is recorded and the access ends by itself.</p>
        </div>
      </div>
      <Agents tokens={rows} sites={choices} origin={ws.origin ?? ""} limits={{ defaultMinutes: AGENT_DEFAULT_MINUTES, maxMinutes: AGENT_MAX_MINUTES, defaultDays: AGENT_DEFAULT_DAYS, maxDays: AGENT_MAX_DAYS }} />
    </main>
  );
}

export default async function AgentsPage() {
  return withRequestTenant(() => AgentsPageImpl());
}
