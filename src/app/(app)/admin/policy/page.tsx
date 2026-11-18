import { requireCapability } from "@/lib/current-user";
import { getSessionPolicyFresh } from "@/lib/policy/session-policy";
import {
  getPlatformSettingsFresh, resolvedGuacParamDefaults, resolvedRecordingConsentRequired, resolvedWatermarkDefault, resolvedRecordingMode,
} from "@/lib/settings/platform";
import { cronHealth, type CronJob } from "@/lib/cron/heartbeat";
import { timeZoneManaged } from "@/lib/tenant/center-time-zone";
import { captivoAccountUrl } from "@/lib/auth/captivo-id-client";
import { currentSessionId } from "@/lib/auth/session";
import { hasSecondFactor } from "@/lib/auth/amr";
import { db } from "@/lib/db";
import { workspaceView } from "@/lib/mobile/views";
import { paramsToGuacFields } from "@/lib/gateway/guac-fields";
import { PolicyView, type PolicyValues, type PolicyEnv } from "./policy-view";
import { withRequestTenant } from "@/lib/tenant/request";
import { sendingMode } from "@/lib/email/mailer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Policy" };

const JOB_LABEL: Record<CronJob, string> = {
  "site-health": "Resource health",
  "audit-retention": "Audit log retention",
  "recording-retention": "Recording retention",
  "audit-anchor": "External anchor",
};

// The server's list, so the first browser render matches the HTML.
function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "Europe/Istanbul", "Europe/London", "America/New_York"];
  }
}

const env = (name: string) => process.env[name]?.trim() || null;
const num = (v: number | null) => (v === null || v === undefined ? "" : String(v));

async function PolicyPageImpl() {
  await requireCapability("configure");
  // Fresh reads (the settings caches are per server module and can be 30 s
  // behind a save); the resolved values below then use this fresh copy.
  const s = await getPlatformSettingsFresh();
  const [ws, policy, cron, guac, consent, watermark, recordingMode, zoneManaged, sid, mail] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    getSessionPolicyFresh(),
    cronHealth(),
    resolvedGuacParamDefaults(),
    resolvedRecordingConsentRequired(),
    resolvedWatermarkDefault(),
    resolvedRecordingMode(),
    timeZoneManaged(),
    currentSessionId(),
    sendingMode().catch(() => null),
  ]);
  const own = sid ? await db.session.findUnique({ where: { id: sid }, select: { amr: true } }) : null;

  // What the form starts from: the stored value, or (where nothing is stored)
  // what applies now, so a switch shows the truth. Saving sends only what the
  // admin changes, so an untouched env-backed value stays with the env.
  const values: PolicyValues = {
    idleTimeoutMinutes: num(policy.idleTimeoutMinutes),
    maxSessionHours: num(policy.maxSessionHours),
    maxConcurrentPerUser: num(policy.maxConcurrentPerUser),
    requireSecondFactor: policy.requireSecondFactor,
    maxGrantDays: num(s.maxGrantDays),
    inviteTtlHours: num(s.inviteTtlHours),
    requireRequestJustification: s.requireRequestJustification ?? true,
    defaultConnectorLogLevel: s.defaultConnectorLogLevel ?? "info",
    vendorIpAllowlist: s.vendorIpAllowlist ?? "",
    isolatedEgressDefault: s.isolatedEgressDefault ?? "internet",
    recordingMode,
    recordingConsentRequired: consent,
    watermarkDefault: watermark,
    clipboardDefault: s.clipboardDefault ?? "allow",
    isolatedFileTransferDefault: s.isolatedFileTransferDefault ?? "none",
    webAppFileTransferDefault: s.webAppFileTransferDefault ?? "allow",
    keystrokeLoggingMode: s.keystrokeLoggingMode ?? "per_resource",
    displayTimezone: s.displayTimezone ?? "",
    recordingRetentionDays: num(s.recordingRetentionDays),
    auditRetentionDays: num(s.auditRetentionDays),
    externalAnchorEnabled: s.externalAnchorEnabled ?? false,
    anchorTsaUrl: s.anchorTsaUrl ?? "",
    notificationWebhookUrl: s.notificationWebhookUrl ?? "",
    notifySiteHealth: s.notifySiteHealth ?? true,
    notifyAccessRequests: s.notifyAccessRequests ?? true,
    notifyAccessDecisions: s.notifyAccessDecisions ?? true,
    guac: paramsToGuacFields(guac),
  };

  // Rows whose value comes from the environment right now (nothing stored).
  const fromEnv: PolicyEnv = {};
  const mark = (key: keyof PolicyEnv, stored: unknown, name: string) => {
    const v = env(name);
    if ((stored === null || stored === undefined) && v) fromEnv[key] = v;
  };
  mark("maxSessionHours", policy.maxSessionHours, "SESSION_TTL_HOURS");
  mark("inviteTtlHours", s.inviteTtlHours, "INVITE_TTL_HOURS");
  mark("auditRetentionDays", s.auditRetentionDays, "AUDIT_RETENTION_DAYS");
  mark("notificationWebhookUrl", s.notificationWebhookUrl, "NOTIFICATION_WEBHOOK_URL");
  mark("recordingConsentRequired", s.recordingConsentRequired, "RECORDING_CONSENT_REQUIRED");
  mark("watermarkDefault", s.watermarkDefault, "WATERMARK_DEFAULT");
  mark("recordingMode", s.recordingMode, "RECORDING_MODE");

  return (
    <main>
      <PolicyView
        workspace={ws.slug}
        initial={values}
        fromEnv={fromEnv}
        hasTsaAuth={!!s.anchorTsaAuth}
        canRequireTwoStep={!!own && hasSecondFactor(own.amr)}
        zoneLockedUrl={zoneManaged ? captivoAccountUrl() : null}
        timeZones={timeZoneList()}
        mailOff={mail === "none"}
        cron={cron.stale.length > 0 ? { anyRun: cron.anyRun, stale: cron.stale.map((x) => JOB_LABEL[x.job]) } : null}
      />
    </main>
  );
}

export default async function AdminPolicyPage(...args: Parameters<typeof PolicyPageImpl>) {
  return withRequestTenant(() => PolicyPageImpl(...args));
}
