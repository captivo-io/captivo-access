import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { ASSIGNABLE_ROLES } from "@/lib/auth/roles";
import { centerRoleOf, consoleRolesFor } from "@/lib/auth/center-role";
import { currentSessionId } from "@/lib/auth/session";
import { signInLabel } from "@/lib/auth/amr";
import { describeAgent } from "@/lib/audit/grouping";
import { getSendingSmtpConfig } from "@/lib/email/mailer";
import { resolvedInviteTtlHours } from "@/lib/settings/platform";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";
import { workspaceView } from "@/lib/mobile/views";
import { currentTenantId } from "@/lib/tenant/context";
import { inviteState, isMobileAgent, latest, userSource, type ConsoleSessionRow, type InviteRowJSON, type PersonRow } from "@/lib/people/rows";
import { PeopleView, type PeopleTab } from "./people-view";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "People" };

const TABS: PeopleTab[] = ["users", "invites", "sessions"];

async function PeoplePageImpl({ searchParams }: { searchParams: Promise<{ q?: string | string[]; tab?: string; new?: string }> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const now = new Date();

  const [ws, users, lastSession, lastPasskey, invites, sessions, currentId, smtp, ttl, tenant] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.user.findMany({
      select: {
        id: true, email: true, name: true, company: true, role: true, status: true,
        directoryManaged: true, centerRole: true, _count: { select: { passkeys: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.session.groupBy({ by: ["userId"], _max: { lastSeenAt: true } }),
    db.passkey.groupBy({ by: ["userId"], _max: { lastUsedAt: true } }),
    db.invite.findMany({ orderBy: { createdAt: "desc" }, include: { createdBy: { select: { name: true, email: true } } } }),
    db.session.findMany({
      // A pending app hand-off code is not a sign-in yet; it becomes one (or
      // disappears) within two minutes.
      where: { expiresAt: { gt: now }, mobileChallenge: null },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, amr: true, user: { select: { email: true, name: true } } },
      orderBy: { lastSeenAt: "desc" },
    }),
    currentSessionId(),
    getSendingSmtpConfig().catch(() => null),
    resolvedInviteTtlHours(),
    db.tenant.findUnique({ where: { id: currentTenantId() }, select: { captivoOrgId: true } }),
  ]);

  const seen = new Map(lastSession.map((s) => [s.userId, s._max.lastSeenAt]));
  const used = new Map(lastPasskey.map((p) => [p.userId, p._max.lastUsedAt]));
  const people: PersonRow[] = users
    .filter((u) => u.role !== "PLATFORM")
    .map((u) => {
      const isSelf = u.id === admin.id;
      const centre = !!u.centerRole;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        company: u.company,
        role: u.role,
        status: u.status === "DISABLED" ? "DISABLED" : "ACTIVE",
        passkeys: u._count.passkeys,
        source: userSource(u),
        lastActive: latest(seen.get(u.id), used.get(u.id)),
        isSelf,
        roles: centre ? consoleRolesFor(centerRoleOf(u.centerRole)) : ASSIGNABLE_ROLES,
        canToggle: !isSelf && !centre,
        canDelete: !isSelf && !centre && u.role !== "ADMIN",
      };
    });

  const inviteRows: InviteRowJSON[] = invites.map((i) => ({
    id: i.id,
    name: i.name,
    email: i.email,
    company: i.company,
    role: i.role,
    state: inviteState(i, now),
    expiresAt: i.expiresAt.toISOString(),
    usedAt: i.usedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
    invitedBy: i.createdBy ? i.createdBy.name || i.createdBy.email : null,
  }));

  const sessionRows: ConsoleSessionRow[] = sessions.map((s) => ({
    id: s.id,
    userName: s.user.name,
    userEmail: s.user.email,
    ip: s.ip,
    userAgent: s.userAgent,
    device: describeAgent(s.userAgent),
    mobile: isMobileAgent(s.userAgent),
    signIn: signInLabel(s.amr),
    startedAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    current: s.id === currentId,
  }));

  const tab = TABS.includes(sp.tab as PeopleTab) ? (sp.tab as PeopleTab) : "users";
  return (
    <main>
      <PeopleView
        workspace={ws.slug}
        initialTab={tab}
        initialQuery={typeof sp.q === "string" ? sp.q : ""}
        openInvite={sp.new === "1"}
        people={people}
        invites={inviteRows}
        sessions={sessionRows}
        canEmail={!!smtp?.enabled}
        inviteTtlHours={ttl}
        centerUrl={tenant?.captivoOrgId ? captivoAccountUrl() : null}
        serverNow={now.getTime()}
      />
    </main>
  );
}

export default async function PeoplePage(...args: Parameters<typeof PeoplePageImpl>) {
  return withRequestTenant(() => PeoplePageImpl(...args));
}
