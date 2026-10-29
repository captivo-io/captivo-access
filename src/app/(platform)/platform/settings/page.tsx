import { withRequestTenant } from "@/lib/tenant/request";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { getPlatformConfig } from "@/lib/platform/config";
import { db } from "@/lib/db";
import { consoleDomain } from "@/lib/tenant/console-domain";
import { PlatformConfigForm } from "./platform-config-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Platform settings" };

export default async function SettingsPage() {
  const { config, platformSmtp, domain } = await withRequestTenant(async () => {
    await requirePlatformAdmin();
    const [config, smtp] = await Promise.all([getPlatformConfig(), db.smtpConfig.findFirst({ select: { enabled: true, host: true } })]);
    return { config, platformSmtp: smtp ? { enabled: smtp.enabled, host: smtp.host } : null, domain: consoleDomain() };
  });
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Platform settings</h1>
          <p>Platform-wide behavior: what new tenants start with, what every tenant console shows, and how the platform reaches you.</p>
        </div>
      </div>
      <PlatformConfigForm
        initial={{
          announcementText: config.announcementText ?? "", announcementLevel: config.announcementLevel, announcementUntil: config.announcementUntil?.toISOString() ?? "",
          opsEmail: config.opsEmail ?? "", smtpFallback: config.smtpFallback, signupEnabled: config.signupEnabled,
          defaults: {
            recordingMode: config.newTenantDefaults?.recordingMode ?? "", keystrokeLoggingMode: config.newTenantDefaults?.keystrokeLoggingMode ?? "",
            auditRetentionDays: config.newTenantDefaults?.auditRetentionDays?.toString() ?? "", recordingRetentionDays: config.newTenantDefaults?.recordingRetentionDays?.toString() ?? "",
            maxGrantDays: config.newTenantDefaults?.maxGrantDays?.toString() ?? "", requireRequestJustification: config.newTenantDefaults?.requireRequestJustification ?? null, displayTimezone: config.newTenantDefaults?.displayTimezone ?? "",
          },
        }}
        platformSmtp={platformSmtp}
        signupUrl={domain ? `https://platform.${domain}/signup` : null}
      />
    </section>
  );
}
