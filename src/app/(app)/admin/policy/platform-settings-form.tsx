"use client";
import { useState } from "react";
import type { PlatformSettings } from "@/lib/settings/platform";
import type { GuacParams } from "@/lib/gateway/guac-params";
import { GuacParamsFields, paramsToGuacFields, guacFieldsToParams, type GuacFields } from "@/components/guac-params-fields";
import { NOTIF_EVENTS, type NotifKey } from "@/lib/notifications/events";
import { TimezoneSelect } from "@/app/(app)/_shell/timezone-select";

function str(n: number | null): string {
  return n == null ? "" : String(n);
}

// *Effective props: the resolved value (DB, else the server env fallback, else the
// product default) so the form shows what actually applies, not just the DB row.
export function PlatformSettingsForm({ initial, consentEffective, watermarkEffective, recordingModeEffective, guacDefaults }: { initial: PlatformSettings; consentEffective: boolean; watermarkEffective?: boolean; recordingModeEffective?: string; guacDefaults: GuacParams }) {
  const [audit, setAudit] = useState(str(initial.auditRetentionDays));
  const [invite, setInvite] = useState(str(initial.inviteTtlHours));
  const [webhook, setWebhook] = useState(initial.notificationWebhookUrl ?? "");
  const [ipAllow, setIpAllow] = useState(initial.vendorIpAllowlist ?? "");
  const [maxGrant, setMaxGrant] = useState(str(initial.maxGrantDays));
  const [requireJustif, setRequireJustif] = useState(initial.requireRequestJustification !== false);
  const [consent, setConsent] = useState(consentEffective);
  const [watermark, setWatermark] = useState(initial.watermarkDefault ?? watermarkEffective ?? false);
  const [clipboardDefault, setClipboardDefault] = useState(initial.clipboardDefault ?? "allow");
  const [ksMode, setKsMode] = useState(initial.keystrokeLoggingMode ?? "per_resource");
  const [recMode, setRecMode] = useState(initial.recordingMode ?? recordingModeEffective ?? "per_resource");
  const [tz, setTz] = useState(initial.displayTimezone ?? "");
  const [recRetention, setRecRetention] = useState(str(initial.recordingRetentionDays));
  const [connLog, setConnLog] = useState(initial.defaultConnectorLogLevel ?? "info");
  const [anchorOn, setAnchorOn] = useState(initial.externalAnchorEnabled === true);
  const [anchorUrl, setAnchorUrl] = useState(initial.anchorTsaUrl ?? "");
  const [anchorAuth, setAnchorAuth] = useState(initial.anchorTsaAuth ?? "");
  const [notif, setNotif] = useState<Record<NotifKey, boolean>>({
    site_health: initial.notifySiteHealth !== false,
    access_requests: initial.notifyAccessRequests !== false,
    access_decisions: initial.notifyAccessDecisions !== false,
  });
  const [guac, setGuac] = useState<GuacFields>(paramsToGuacFields(guacDefaults));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function resetAllConnectors() {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/admin/policy/connector-log-level/reset-all", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    setNotice(
      res.ok && body.ok
        ? { kind: "ok", msg: `Reset ${body.count ?? 0} connector(s) to the default (save the default first if you just changed it).` }
        : { kind: "err", msg: "Could not reset connectors." },
    );
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/admin/policy/platform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auditRetentionDays: audit,
        inviteTtlHours: invite,
        notificationWebhookUrl: webhook,
        vendorIpAllowlist: ipAllow,
        maxGrantDays: maxGrant,
        requireRequestJustification: requireJustif,
        recordingConsentRequired: consent,
        watermarkDefault: watermark,
        clipboardDefault,
        keystrokeLoggingMode: ksMode,
        recordingMode: recMode,
        displayTimezone: tz || null,
        recordingRetentionDays: recRetention,
        defaultConnectorLogLevel: connLog,
        externalAnchorEnabled: anchorOn,
        anchorTsaUrl: anchorUrl,
        anchorTsaAuth: anchorAuth,
        notifySiteHealth: notif.site_health,
        notifyAccessRequests: notif.access_requests,
        notifyAccessDecisions: notif.access_decisions,
        guacParamDefaults: guacFieldsToParams(guac),
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && body.ok) {
      setNotice({ kind: "ok", msg: "Saved." });
    } else if (body.error === "invalid_cidr") {
      setNotice({ kind: "err", msg: `Invalid IP/CIDR entries: ${(body.invalid ?? []).join(", ")}` });
    } else if (body.error === "invalid_webhook_url") {
      setNotice({ kind: "err", msg: "The webhook URL must be a valid http(s) URL." });
    } else if (body.error === "anchor_tsa_required") {
      setNotice({ kind: "err", msg: "Enter a TSA URL to enable external anchoring." });
    } else if (body.error === "anchor_tsa_invalid") {
      setNotice({ kind: "err", msg: "The TSA URL must be a valid http(s) URL." });
    } else {
      setNotice({ kind: "err", msg: "Could not save." });
    }
  }

  const allowEntries = ipAllow.split(/[\s,]+/).filter(Boolean);

  return (
    <div>
      <div className="card">
        <div className="card-head"><h2>Access &amp; grants</h2></div>
        <div className="settings">
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Maximum grant duration</div>
              <div className="setting-hint">Every grant must expire and can&apos;t exceed this — time-boxed vendor access, no standing grants. Empty = no cap. Existing grants are unaffected until edited.</div>
            </div>
            <div className="setting-ctl">
              <input type="number" min={1} className="input" style={{ width: "5rem" }} value={maxGrant} onChange={(e) => setMaxGrant(e.target.value)} placeholder="—" aria-label="Maximum grant duration in days" />
              <span className="unit">days</span>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Invitation link lifetime</div>
              <div className="setting-hint">How long a new invite link stays valid before it expires.</div>
            </div>
            <div className="setting-ctl">
              <input type="number" min={1} className="input" style={{ width: "5rem" }} value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="48" aria-label="Invite lifetime hours" />
              <span className="unit">hours</span>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Require justification on access requests</div>
              <div className="setting-hint">When on, a vendor must explain why they need access before requesting it. Off makes the justification field optional.</div>
            </div>
            <div className="setting-ctl">
              <label className="switch"><input type="checkbox" checked={requireJustif} onChange={(e) => setRequireJustif(e.target.checked)} /><span className="track" /></label>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Connectors</h2></div>
        <div className="settings">
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Default connector log level</div>
              <div className="setting-hint">For connectors set to &quot;Use default&quot; on their detail page — a connector&apos;s own level overrides it. Save first, then <b>Reset all</b> switches every connector back to this default (pushed live to online ones).</div>
            </div>
            <div className="setting-ctl">
              <select className="select" value={connLog} onChange={(e) => setConnLog(e.target.value)} aria-label="Default connector log level">
                <option value="error">Error</option>
                <option value="warn">Warn</option>
                <option value="info">Info</option>
                <option value="debug">Debug</option>
              </select>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={resetAllConnectors}>Reset all</button>
            </div>
          </div>
          <div className="setting setting-stack">
            <div className="setting-main">
              <div className="setting-label">Remote-desktop defaults</div>
              <div className="setting-hint">Default Guacamole connection parameters for remote-desktop (RDP/SSH/VNC) resources. A resource can override any of these on its own form. Layout &amp; the visual toggles apply to RDP; colour depth to RDP/VNC.</div>
            </div>
            <div className="setting-ctl" style={{ width: "100%" }}>
              <GuacParamsFields value={guac} onChange={setGuac} />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Network &amp; security</h2></div>
        <div className="settings">
          <div className="setting setting-stack">
            <div className="setting-main">
              <div className="setting-label">Vendor source-IP allowlist</div>
              <div className="setting-hint">
                When set, vendors can reach published <b>resources</b> only from these networks (checked live; the console is never gated, so you can&apos;t lock yourself out). <b>Empty = no restriction.</b> <b>Include your own network.</b> The evaluated IP is the one your front proxy records — a forged <code>X-Forwarded-For</code> won&apos;t bypass it.
              </div>
              {allowEntries.length > 0 && (
                <div className="chips" style={{ marginTop: ".55rem" }}>
                  {allowEntries.map((e, i) => <span key={i} className="chip">{e}</span>)}
                </div>
              )}
            </div>
            <div className="setting-ctl">
              <textarea className="textarea" rows={2} value={ipAllow} onChange={(e) => setIpAllow(e.target.value)} placeholder="203.0.113.0/24, 198.51.100.10, 2001:db8::/32" />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Session recording</h2></div>
        <div className="settings">
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Session recording mode</div>
              <div className="setting-hint">Governs whether a resource records vendor sessions. <b>Off</b> disables recording for every resource. <b>Per resource</b> lets each resource decide on its own form. <b>Required</b> forces recording on for every resource — resources cannot opt out.</div>
            </div>
            <div className="setting-ctl">
              <select className="select" value={recMode} onChange={(e) => setRecMode(e.target.value)} aria-label="Session recording mode">
                <option value="off">Off — disabled for all resources</option>
                <option value="per_resource">Per resource — each resource decides</option>
                <option value="required">Required — on for every resource</option>
              </select>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Require recording consent</div>
              <div className="setting-hint">On recorded resources, show the vendor a one-time &quot;this session is recorded&quot; acknowledgement before any app content loads. The banner and &quot;Recorded&quot; label are always shown regardless.</div>
            </div>
            <div className="setting-ctl">
              <label className="switch"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span className="track" /></label>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Screen watermark</div>
              <div className="setting-hint">Default for Isolated Browser sessions: overlay each session with the vendor&apos;s email + a live clock, visible on their screen and in any screenshot or photo (deters + attributes leaks). A resource can override this on its own form.</div>
            </div>
            <div className="setting-ctl">
              <label className="switch"><input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} /><span className="track" /></label>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Default clipboard policy</div>
              <div className="setting-hint">Applied to resources set to <b>Inherit</b> (copy/paste between the vendor and the remote desktop or isolated browser). Per-resource overrides win. <b>Allow</b> keeps the current behavior.</div>
            </div>
            <div className="setting-ctl">
              <select id="policy-clipboard" className="select" value={clipboardDefault} onChange={(e) => setClipboardDefault(e.target.value)}>
                <option value="allow">Allow copy &amp; paste</option>
                <option value="no_copy">Block copy out (no exfil)</option>
                <option value="no_paste">Block paste in</option>
                <option value="none">Block both</option>
              </select>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Keystroke logging</div>
              <div className="setting-hint">Governs the SSH/RDP keystroke timeline for gateway sessions. Applies only to sessions where recording is enabled. <b>Per resource</b> lets each resource decide; <b>Required</b> forces it on for every recorded gateway session (a resource cannot turn it off).</div>
            </div>
            <div className="setting-ctl">
              <select className="select" value={ksMode} onChange={(e) => setKsMode(e.target.value)} aria-label="Keystroke logging mode">
                <option value="off">Off — disabled for all resources</option>
                <option value="per_resource">Per resource — each resource decides</option>
                <option value="required">Required — on for every recorded session</option>
              </select>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Display timezone</div>
              <div className="setting-hint">Dates and times across the console and vendor portal display in this timezone. Users can override it in their own settings. Data is always stored in UTC.</div>
            </div>
            <div className="setting-ctl">
              <TimezoneSelect value={tz} onChange={setTz} inheritLabel="Use each viewer's browser timezone" />
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Session recording retention</div>
              <div className="setting-hint">Recorded sessions older than this are deleted by the recording-retention cron (audited). Empty = kept indefinitely. Needs the <code>/api/cron/recording-retention</code> job scheduled.</div>
            </div>
            <div className="setting-ctl">
              <input type="number" min={1} className="input" style={{ width: "5rem" }} value={recRetention} onChange={(e) => setRecRetention(e.target.value)} placeholder="—" aria-label="Recording retention days" />
              <span className="unit">days</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Audit log</h2></div>
        <div className="settings">
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">Audit log retention</div>
              <div className="setting-hint">Older audit rows are trimmed by the retention cron, preserving the tamper-evident chain. <code>0</code> keeps nothing beyond today; empty uses the default (730).</div>
            </div>
            <div className="setting-ctl">
              <input type="number" min={0} className="input" style={{ width: "5rem" }} value={audit} onChange={(e) => setAudit(e.target.value)} placeholder="730" aria-label="Audit retention days" />
              <span className="unit">days</span>
            </div>
          </div>
          <div className="setting">
            <div className="setting-main">
              <div className="setting-label">External anchor (RFC 3161)</div>
              <div className="setting-hint">Daily, timestamp the audit-log chain head with a Time-Stamp Authority so history can&apos;t be back-dated even by someone with full database access. Needs the <code>/api/cron/audit-anchor</code> job scheduled. Off by default.</div>
            </div>
            <div className="setting-ctl">
              <label className="switch"><input type="checkbox" checked={anchorOn} onChange={(e) => setAnchorOn(e.target.checked)} /><span className="track" /></label>
            </div>
          </div>
          <div className="setting setting-stack">
            <div className="setting-main">
              <div className="setting-label">Time-Stamp Authority URL</div>
              <div className="setting-hint">Any RFC 3161 TSA — a public one (e.g. <code>https://freetsa.org/tsr</code>), a commercial one, or your own. Optional <code>user:pass</code> if it needs HTTP Basic auth.</div>
            </div>
            <div className="setting-ctl">
              <input type="url" className="input" style={{ width: "100%" }} value={anchorUrl} onChange={(e) => setAnchorUrl(e.target.value)} placeholder="https://freetsa.org/tsr" />
              <input type="text" className="input" style={{ width: "100%", marginTop: ".4rem" }} value={anchorAuth} onChange={(e) => setAnchorAuth(e.target.value)} placeholder="user:pass (optional)" aria-label="TSA basic auth" />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Notifications</h2></div>
        <div className="settings">
          <div className="setting setting-stack">
            <div className="setting-main">
              <div className="setting-label">Notification webhook URL</div>
              <div className="setting-hint">Resource up/down events POST here (Slack/Teams-friendly JSON), in addition to the in-console bell. Empty = disabled.</div>
            </div>
            <div className="setting-ctl">
              <input type="url" className="input" style={{ width: "100%" }} value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://hooks.slack.com/…" />
            </div>
          </div>
          {NOTIF_EVENTS.map((ev) => (
            <div className="setting" key={ev.key}>
              <div className="setting-main">
                <div className="setting-label">Email: {ev.label}</div>
                <div className="setting-hint">{ev.hint}</div>
              </div>
              <div className="setting-ctl">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={notif[ev.key]}
                    onChange={(e) => setNotif((n) => ({ ...n, [ev.key]: e.target.checked }))}
                  />
                  <span className="track" />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      {notice && <p className={`notice ${notice.kind === "ok" ? "success" : "error"}`} role="alert" style={{ marginTop: "1rem" }}>{notice.msg}</p>}
      <div className="row-actions" style={{ marginTop: "1.1rem" }}>
        <button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
      </div>
    </div>
  );
}
