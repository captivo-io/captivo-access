import { describe, it, expect } from "vitest";
import { applyPolicyChanges } from "./patch";
import { validateAllowlist } from "@/lib/net/cidr";
import { isValidTimeZone } from "@/lib/time/datetime-local";
import { parseGuacParams } from "@/lib/gateway/guac-params";
import type { PlatformSettings } from "@/lib/settings/platform";

const platform = Object.fromEntries([
  "auditRetentionDays", "inviteTtlHours", "notificationWebhookUrl", "vendorIpAllowlist", "maxGrantDays", "recordingConsentRequired",
  "watermarkDefault", "clipboardDefault", "displayTimezone", "recordingRetentionDays", "defaultConnectorLogLevel", "externalAnchorEnabled",
  "anchorTsaUrl", "anchorTsaAuth", "notifySiteHealth", "notifyAccessRequests", "notifyAccessDecisions", "requireRequestJustification",
  "keystrokeLoggingMode", "recordingMode", "isolatedEgressDefault", "isolatedFileTransferDefault", "webAppFileTransferDefault",
].map((k) => [k, null])) as unknown as PlatformSettings;
const current = { session: { idleTimeoutMinutes: null, maxSessionHours: null, maxConcurrentPerUser: null, requireSecondFactor: false }, platform };
const ctx = { zoneManaged: false, validAllowlist: validateAllowlist, validZone: isValidTimeZone, parseGuac: parseGuacParams };

describe("applyPolicyChanges", () => {
  it("touches only the keys sent, so env-backed nulls stay null", () => {
    const r = applyPolicyChanges(current, { inviteTtlHours: "72" }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.platform?.inviteTtlHours).toBe(72);
    expect(r.platform?.recordingConsentRequired).toBeNull();
    expect(r.platform?.recordingMode).toBeNull();
    expect(r.session).toBeNull();
    expect(r.changed).toEqual(["inviteTtlHours"]);
  });
  it("routes session keys to the session policy", () => {
    const r = applyPolicyChanges(current, { idleTimeoutMinutes: 15, requireSecondFactor: true }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.session).toEqual({ idleTimeoutMinutes: 15, maxSessionHours: null, maxConcurrentPerUser: null, requireSecondFactor: true });
    expect(r.platform).toBeNull();
  });
  it("clears a number with an empty value", () => {
    const r = applyPolicyChanges({ ...current, platform: { ...platform, maxGrantDays: 30 } }, { maxGrantDays: "" }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.platform?.maxGrantDays).toBeNull();
  });
  it("refuses bad values with the codes the page knows", () => {
    expect(applyPolicyChanges(current, { vendorIpAllowlist: "10.0.0.300, 10.0.0.0/8" }, ctx)).toEqual({ error: "invalid_cidr", key: "vendorIpAllowlist", invalid: ["10.0.0.300"] });
    expect(applyPolicyChanges(current, { notificationWebhookUrl: "ftp://x" }, ctx)).toMatchObject({ error: "invalid_webhook_url" });
    expect(applyPolicyChanges(current, { displayTimezone: "Mars/Olympus" }, ctx)).toMatchObject({ error: "invalid_timezone" });
    expect(applyPolicyChanges(current, { externalAnchorEnabled: true }, ctx)).toMatchObject({ error: "anchor_tsa_required" });
    expect(applyPolicyChanges(current, { recordingMode: "sometimes" }, ctx)).toMatchObject({ error: "invalid_value", key: "recordingMode" });
    expect(applyPolicyChanges(current, { maxGrantDays: 0 }, ctx)).toMatchObject({ error: "invalid_value" });
    expect(applyPolicyChanges(current, { somethingElse: 1 }, ctx)).toMatchObject({ error: "unknown_setting" });
  });
  it("keeps the centre's time zone", () => {
    const r = applyPolicyChanges({ ...current, platform: { ...platform, displayTimezone: "Europe/Istanbul" } }, { displayTimezone: "UTC" }, { ...ctx, zoneManaged: true });
    if ("error" in r) throw new Error(r.error);
    expect(r.platform).toBeNull();
  });
  it("replaces the remote-desktop defaults with the parsed object", () => {
    const r = applyPolicyChanges(current, { guacParamDefaults: { serverLayout: "tr-tr-qwerty", nonsense: 1 } }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.guac).toEqual({ serverLayout: "tr-tr-qwerty" });
  });
});
