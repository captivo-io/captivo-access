import { requireAdmin } from "@/lib/current-user";
import { getSmtpConfig, sendingMode } from "@/lib/email/mailer";
import { inviteEmail } from "@/lib/email/templates";
import { workspaceView } from "@/lib/mobile/views";
import { EmailForm } from "./email-form";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email" };

async function AdminEmailPageImpl() {
  const admin = await requireAdmin();
  const [cfg, mode, ws] = await Promise.all([
    getSmtpConfig(),
    sendingMode().catch(() => "none" as const),
    workspaceView().catch(() => ({ name: "", slug: null as string | null, origin: "" })),
  ]);
  const initial = cfg
    ? { host: cfg.host, port: cfg.port, secure: cfg.secure, username: cfg.username, fromName: cfg.fromName, fromEmail: cfg.fromEmail, enabled: cfg.enabled, hasPassword: true }
    : { host: "", port: 587, secure: false, username: "", fromName: "Captivo Access", fromEmail: "", enabled: false, hasPassword: false };

  // The real invite email, with sample values, for the preview beside the form.
  const preview = inviteEmail({ name: "Ayşe Yılmaz", link: `${ws.origin || "https://access.example.com"}/invite/…` });

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform{ws.slug ? ` · ${ws.slug}` : ""}</div>
          <h1>Email</h1>
          <p>Outgoing SMTP settings. Invite links and admin alerts are sent through this server.</p>
        </div>
      </div>
      <EmailForm initial={initial} adminEmail={admin.email} mode={mode} preview={{ subject: preview.subject, html: preview.html }} />
    </main>
  );
}

export default async function AdminEmailPage(...args: Parameters<typeof AdminEmailPageImpl>) {
  return withRequestTenant(() => AdminEmailPageImpl(...args));
}
