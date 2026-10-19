import { requireAdmin } from "@/lib/current-user";
import { SessionsIcon } from "@/components/icons";
import { db } from "@/lib/db";
import { currentSessionId } from "@/lib/auth/session";
import { SessionsTable, type SessionRow } from "./sessions-table";
import { withRequestTenant } from "@/lib/tenant/request";
import { signInLabel } from "@/lib/auth/amr";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sessions" };

async function AdminSessionsPageImpl() {
  await requireAdmin();

  const [sessions, currentId] = await Promise.all([
    db.session.findMany({
      where: { expiresAt: { gt: new Date() } },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        lastSeenAt: true,
        amr: true,
        user: { select: { email: true, name: true } },
      },
      orderBy: { lastSeenAt: "desc" },
    }),
    currentSessionId(),
  ]);

  const rows: SessionRow[] = sessions.map((s) => ({
    id: s.id,
    ip: s.ip,
    userAgent: s.userAgent,
    lastSeenAt: s.lastSeenAt.toISOString(),
    signIn: signInLabel(s.amr),
    userName: s.user.name,
    userEmail: s.user.email,
  }));

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><SessionsIcon /></span><h1>Sessions</h1></div>
          <p>All currently active (non-expired) sessions.</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No active sessions.</div>
      ) : (
        <SessionsTable sessions={rows} currentSessionId={currentId} />
      )}
    </main>
  );
}

export default async function AdminSessionsPage(...args: Parameters<typeof AdminSessionsPageImpl>) {
  return withRequestTenant(() => AdminSessionsPageImpl(...args));
}

