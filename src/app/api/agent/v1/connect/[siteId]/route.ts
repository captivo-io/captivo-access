import { NextResponse } from "next/server";
import { withTenantRoute } from "@/lib/tenant/request";
import { withAgent } from "@/lib/agent/route";
import { issueSshTicket } from "@/lib/gateway/native-ssh-issue";
import { recordedHostKeyAlias, sshCommand } from "@/lib/gateway/native-ssh-command";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A ready SSH command for the resource, valid for two minutes, once the
// agent's access is active. A recorded resource signs in as its saved
// account: the agent gives no password or key, and the session is recorded.
export const POST = withTenantRoute(withAgent(async (req, agent, ctx: { params: Promise<{ siteId: string }> }) => {
  const { siteId } = await ctx.params;
  if (!agent.token.siteIds.includes(siteId)) return NextResponse.json({ error: "site_not_allowed" }, { status: 403 });
  const r = await issueSshTicket(agent.user, siteId, req);
  if (r.status === 404) return NextResponse.json({ error: "no_active_access", message: "Ask for access first and wait until it is approved." }, { status: 403 });
  if (r.status !== 200) return NextResponse.json(r.body, { status: r.status });
  const t = r.body as { code: string; jumpHost: string; jumpPort: number; targetHost: string; targetPort: number; recorded: boolean; tunnel: boolean; username?: string };
  const command = t.tunnel ? null : sshCommand({
    code: t.code, jumpHost: t.jumpHost, jumpPort: t.jumpPort, targetHost: t.targetHost, targetPort: t.targetPort,
    user: t.recorded ? t.username ?? "" : "USER", hostKeyAlias: t.recorded ? recordedHostKeyAlias(t.jumpHost) : undefined,
  });
  return NextResponse.json({ ...r.body, command }, { status: 200 });
}));
