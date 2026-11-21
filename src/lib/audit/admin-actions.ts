const LABELS: Record<string, string> = {
  "grant.create": "Grant created",
  "grant.update": "Grant updated",
  "grant.approve": "Grant approved",
  "grant.deny": "Grant denied",
  "grant.revoke": "Grant revoked",
  "session.terminate": "Session terminated",
  "session.message": "Message sent to a session",
  "authsession.revoke": "Auth session revoked",
  "user.update": "User updated",
  "user.delete": "User deleted",
  "user.passkeys_reset": "Passkeys reset",
  "invite.create": "Invite created",
  "invite.revoke": "Invite revoked",
  "invite.resend": "New invite link created",
  "connector.create": "Connector created",
  "connector.revoke": "Connector revoked",
  "connector.delete": "Connector deleted",
  "connector.group_create": "Connector group created",
  "connector.group_update": "Connector group updated",
  "connector.group_delete": "Connector group deleted",
  "connector.vault_reshare": "Saved passwords copied to a group member",
  "resource.create": "Resource created",
  "resource.update": "Resource updated",
  "resource.delete": "Resource deleted",
  "resource.vault_update": "Resource credential updated",
  "config.smtp_update": "SMTP settings updated",
  "config.sso_update": "SSO settings updated",
  "config.platform_update": "Policy updated",
  "config.session_policy_update": "Session policy updated",
  "config.log_level_reset": "Connector log level reset",
  "config.webhook_test": "Webhook test sent",
  "config.directory_update": "Directory settings updated",
  "config.directory_mapping_create": "Directory mapping created",
  "config.directory_mapping_update": "Directory mapping updated",
  "config.directory_mapping_delete": "Directory mapping deleted",
  "config.updates_update": "Update settings updated",
  "connector.egress_update": "Connector egress policy updated",
  "connector.log_level": "Connector log level set",
  "connector.repair": "Connector repaired",
  "recording.delete": "Recording deleted",
  "recording.erasure_requested": "Recording erasure requested",
  "recording.download": "Recording downloaded",
  "connector.pairing_delete": "Connector pairing deleted",
  "config.sso_remove": "SSO removed",
  "branding.update": "Branding updated",
  "platform.support.access": "Support access changed",
  "platform.support.session_start": "Support session started",
  "platform.support.session_end": "Support session ended",
};

// The Audit page's category filter (design hand-off 7.9), by action prefix.
export type AdminCategory = "connector" | "recording" | "access" | "resource" | "identity" | "settings";

export const ADMIN_CATEGORY_PREFIXES: Record<AdminCategory, string[]> = {
  connector: ["connector.", "config.log_level"],
  recording: ["recording."],
  access: ["grant.", "session."],
  resource: ["resource."],
  identity: ["user.", "invite.", "authsession.", "config.sso", "config.directory"],
  settings: ["config.smtp", "config.platform", "config.session_policy", "config.updates", "branding.", "platform."],
};

export function adminCategory(action: string): AdminCategory {
  for (const [c, prefixes] of Object.entries(ADMIN_CATEGORY_PREFIXES) as [AdminCategory, string[]][]) {
    if (prefixes.some((p) => action.startsWith(p))) return c;
  }
  return "settings";
}

export function isAdminCategory(v: string | null | undefined): v is AdminCategory {
  return !!v && Object.hasOwn(ADMIN_CATEGORY_PREFIXES, v);
}

export function adminActionLabel(action: string): string {
  return LABELS[action] ?? action;
}

// One sentence for a merged run of the same action (the page merges repeats by
// the same admin within a minute). Unknown actions repeat the newest summary.
const MERGED: Record<string, (n: number) => string> = {
  "recording.erasure_requested": (n) => `Requested erasure of ${n} recordings (applied when their connectors confirm)`,
  "recording.delete": (n) => `Deleted ${n} recordings`,
  "recording.download": (n) => `Downloaded ${n} recordings`,
  "grant.revoke": (n) => `Revoked ${n} grants`,
  "grant.create": (n) => `Created ${n} grants`,
  "session.terminate": (n) => `Terminated ${n} sessions`,
  "authsession.revoke": (n) => `Revoked ${n} sign-in sessions`,
  "invite.create": (n) => `Sent ${n} invites`,
};

export function adminMergedSummary(action: string, count: number, latest: string): string {
  if (count <= 1) return latest;
  return MERGED[action]?.(count) ?? `${count} times. Latest: ${latest}`;
}
