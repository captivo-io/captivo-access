import { requireAdmin } from "@/lib/current-user";
import { InviteIcon } from "@/components/icons";
import { db } from "@/lib/db";
import { getSmtpConfig } from "@/lib/email/mailer";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { AddInviteButton } from "./add-invite-button";
import { InvitesTable, type InviteRow } from "./invites-table";
import { withRequestTenant } from "@/lib/tenant/request";
import { currentTenantId } from "@/lib/tenant/context";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invites" };

function inviteStatus(inv: { usedAt: Date | null; expiresAt: Date }): string {
  if (inv.usedAt) return "Used";
  if (inv.expiresAt < new Date()) return "Expired";
  return "Pending";
}

async function AdminInvitesPageImpl() {
  await requireAdmin();

  const smtp = await getSmtpConfig();
  const smtpEnabled = !!smtp?.enabled;

  // A workspace that belongs to a Captivo organisation gets its members from
  // the centre (lib/auth/center-role.ts); the invites here are for vendors.
  const tenant = await db.tenant.findUnique({ where: { id: currentTenantId() }, select: { captivoOrgId: true } });
  const centerUrl = tenant?.captivoOrgId ? captivoAccountUrl() : null;

  const invites = await db.invite.findMany({ orderBy: { createdAt: "desc" } });
  const rows: InviteRow[] = invites.map((inv) => ({
    id: inv.id,
    name: inv.name,
    email: inv.email,
    company: inv.company,
    phone: inv.phone,
    roleLabel: ROLE_LABELS[inv.role] ?? inv.role,
    status: inviteStatus(inv),
    expiresAt: inv.expiresAt.toISOString(),
  }));

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="page-title-row"><span className="page-icon"><InviteIcon /></span><h1>Invitations</h1></div>
          <p>{centerUrl ? "Invite a vendor. The invite link is shown only once." : "Invite a new vendor or admin. The invite link is shown only once."}</p>
        </div>
        <AddInviteButton smtpEnabled={smtpEnabled} vendorOnly={!!centerUrl} />
      </div>

      {centerUrl && (
        <div className="notice" role="note">
          This workspace belongs to a Captivo organisation. Organisation members (admins, operators, auditors, staff) are invited on the{" "}
          <a href={centerUrl}>Captivo account page</a>; their roles come from there and can only be narrowed here. Invitations on this page are for vendors, who sign in with a passkey and have no Captivo account.
        </div>
      )}

      <h2>Sent invites</h2>
      {invites.length === 0 ? (
        <div className="empty">No invites have been sent yet.</div>
      ) : (
        <InvitesTable rows={rows} />
      )}
    </main>
  );
}

export default async function AdminInvitesPage(...args: Parameters<typeof AdminInvitesPageImpl>) {
  return withRequestTenant(() => AdminInvitesPageImpl(...args));
}

