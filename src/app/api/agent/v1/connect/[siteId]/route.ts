import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withTenantRoute } from "@/lib/tenant/request";
import { withAgent } from "@/lib/agent/route";
import { agentKind } from "@/lib/agent/sites";
import { agentSession } from "@/lib/agent/session";
import { issueSshTicket } from "@/lib/gateway/native-ssh-issue";
import { recordedHostKeyAlias, sshCommand } from "@/lib/gateway/native-ssh-command";
import { issueDbTicket } from "@/lib/database/issue";
import { issueKubeTicket } from "@/lib/kubernetes/issue";
import { issueRdpFile } from "@/lib/gateway/native-rdp-issue";
import { evaluateAccess } from "@/lib/access/evaluate";
import { mongoUrl, mongoshCommand, mysqlCommand, psqlCommand, redisCliCommand, redisUrl, sqlcmdCommand } from "@/lib/database/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_ACCESS = { error: "no_active_access", message: "Ask for access first and wait until it is approved." };

// How an agent reaches a resource once its access is active, by kind:
//   ssh / tunnel  a command through the jump host, good for two minutes
//   database      the proxy's address and a ticket, and the client's command
//   kubernetes    a kubeconfig whose token is a ticket
// Captivo signs in with the saved account everywhere it can, so the agent
// holds no password or key; the session is recorded as for a person.
export const POST = withTenantRoute(withAgent(async (req, agent, ctx: { params: Promise<{ siteId: string }> }) => {
  const { siteId } = await ctx.params;
  if (!agent.token.siteIds.includes(siteId)) return NextResponse.json({ error: "site_not_allowed" }, { status: 403 });
  const site = await db.site.findUnique({ where: { id: siteId }, select: { accessMode: true, hostname: true, vaultCredential: { select: { protocol: true } } } });
  const kind = site ? agentKind(site) : null;
  if (!site || !kind) return NextResponse.json({ error: "site_not_supported" }, { status: 400 });

  if (kind === "web") {
    // Nothing to issue: the agent calls the app's own address with its token in a header, and the
    // proxy checks the access, records and logs every request as for a person.
    const d = await evaluateAccess(agent.user.id, siteId, new Date());
    if (!d.allow || !site.hostname) return NextResponse.json(NO_ACCESS, { status: 403 });
    return NextResponse.json({ kind, url: `https://${site.hostname}/`, header: "X-Captivo-Agent-Token", note: "Send your agent token in that header with every request to the url. The application's own Authorization header is left alone." });
  }

  if (kind === "rdp") {
    const r = await issueRdpFile(agent.user, siteId, req);
    if (r.status === 404) return NextResponse.json(NO_ACCESS, { status: 403 });
    if (r.status !== 200) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ kind, fileName: r.fileName, rdp: r.body, recorded: r.recorded, expiresAt: r.expiresAt!.toISOString(), command: `xfreerdp ${r.fileName}` });
  }

  if (kind === "ssh" || kind === "tunnel") {
    const r = await issueSshTicket(agent.user, siteId, req);
    if (r.status === 404) return NextResponse.json(NO_ACCESS, { status: 403 });
    if (r.status !== 200) return NextResponse.json(r.body, { status: r.status });
    const t = r.body as { code: string; jumpHost: string; jumpPort: number; targetHost: string; targetPort: number; recorded: boolean; tunnel: boolean; username?: string };
    const command = t.tunnel ? null : sshCommand({
      code: t.code, jumpHost: t.jumpHost, jumpPort: t.jumpPort, targetHost: t.targetHost, targetPort: t.targetPort,
      user: t.recorded ? t.username ?? "" : "USER", hostKeyAlias: t.recorded ? recordedHostKeyAlias(t.jumpHost) : undefined,
    });
    return NextResponse.json({ kind, ...r.body, command });
  }

  const session = await agentSession(agent.user.id);
  if (kind === "kubernetes") {
    const r = await issueKubeTicket(agent.user, session, siteId, req);
    if (r.status === 404 || r.status === 403) return NextResponse.json(NO_ACCESS, { status: 403 });
    return NextResponse.json(r.status === 200 ? { kind, ...r.body, command: `kubectl --kubeconfig <file> get pods` } : r.body, { status: r.status });
  }
  const r = await issueDbTicket(agent.user, session, siteId, req);
  if (r.status === 404 || r.status === 403) return NextResponse.json(NO_ACCESS, { status: 403 });
  if (r.status !== 200) return NextResponse.json(r.body, { status: r.status });
  const d = r.body as { ticket: string; host: string; port: number; database: string; engine: string };
  const c = { host: d.host, port: d.port, ticket: d.ticket, database: d.database };
  const command = d.engine === "mysql" ? mysqlCommand(c) : d.engine === "mssql" ? sqlcmdCommand(c) : d.engine === "redis" ? redisCliCommand(c) : d.engine === "mongodb" ? mongoshCommand(c) : psqlCommand(c);
  const url = d.engine === "redis" ? redisUrl(c) : d.engine === "mongodb" ? mongoUrl(c) : null;
  return NextResponse.json({ kind, ...r.body, command, ...(url ? { url } : {}) });
}, { action: "connect" }));
