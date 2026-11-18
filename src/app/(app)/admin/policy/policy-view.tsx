"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { guacFieldsToParams, type GuacFields } from "@/lib/gateway/guac-fields";
import { KEYBOARD_LAYOUTS, TERMINAL_COLOR_SCHEMES } from "@/lib/gateway/guac-params";
import { NOTIF_EVENTS } from "@/lib/notifications/events";
import { checkAllowlist } from "@/lib/policy/allowlist";

export interface PolicyValues {
  idleTimeoutMinutes: string;
  maxSessionHours: string;
  maxConcurrentPerUser: string;
  requireSecondFactor: boolean;
  maxGrantDays: string;
  inviteTtlHours: string;
  requireRequestJustification: boolean;
  defaultConnectorLogLevel: string;
  vendorIpAllowlist: string;
  isolatedEgressDefault: string;
  recordingMode: string;
  recordingConsentRequired: boolean;
  watermarkDefault: boolean;
  clipboardDefault: string;
  isolatedFileTransferDefault: string;
  webAppFileTransferDefault: string;
  keystrokeLoggingMode: string;
  displayTimezone: string;
  recordingRetentionDays: string;
  auditRetentionDays: string;
  externalAnchorEnabled: boolean;
  anchorTsaUrl: string;
  notificationWebhookUrl: string;
  notifySiteHealth: boolean;
  notifyAccessRequests: boolean;
  notifyAccessDecisions: boolean;
  guac: GuacFields;
}
type FlatKey = Exclude<keyof PolicyValues, "guac">;
/** Rows whose value comes from an environment variable now, with that value. */
export type PolicyEnv = Partial<Record<"maxSessionHours" | "inviteTtlHours" | "auditRetentionDays" | "notificationWebhookUrl" | "recordingConsentRequired" | "watermarkDefault" | "recordingMode", string>>;

type SectionId = "session" | "access" | "connectors" | "network" | "recording" | "audit" | "notifications";
const SECTION_OF: Record<FlatKey | "guac" | "anchorTsaAuth", SectionId> = {
  idleTimeoutMinutes: "session", maxSessionHours: "session", maxConcurrentPerUser: "session", requireSecondFactor: "session",
  maxGrantDays: "access", inviteTtlHours: "access", requireRequestJustification: "access",
  defaultConnectorLogLevel: "connectors", guac: "connectors",
  vendorIpAllowlist: "network", isolatedEgressDefault: "network",
  recordingMode: "recording", recordingConsentRequired: "recording", watermarkDefault: "recording", clipboardDefault: "recording",
  isolatedFileTransferDefault: "recording", webAppFileTransferDefault: "recording", keystrokeLoggingMode: "recording",
  displayTimezone: "recording", recordingRetentionDays: "recording",
  auditRetentionDays: "audit", externalAnchorEnabled: "audit", anchorTsaUrl: "audit", anchorTsaAuth: "audit",
  notificationWebhookUrl: "notifications", notifySiteHealth: "notifications", notifyAccessRequests: "notifications", notifyAccessDecisions: "notifications",
};
const SECTIONS: { id: SectionId; title: string; sub: string; icon: string }[] = [
  { id: "session", title: "Session controls", sub: "Applied to console and vendor sessions.", icon: "clock" },
  { id: "access", title: "Access & grants", sub: "Grant length, invite links and access requests.", icon: "key" },
  { id: "connectors", title: "Connectors", sub: "Default log level and remote desktop settings.", icon: "plug" },
  { id: "network", title: "Network & security", sub: "Where vendors may connect from, and what isolated browsers may reach.", icon: "shield" },
  { id: "recording", title: "Session recording", sub: "Recording, consent, watermark, clipboard and file transfer.", icon: "video" },
  { id: "audit", title: "Audit log", sub: "Retention and an external timestamp for the log's integrity.", icon: "list" },
  { id: "notifications", title: "Notifications", sub: "A webhook and email alerts.", icon: "bell" },
];

function errorText(code: string | undefined, invalid?: string[]): string {
  switch (code) {
    case "invalid_cidr": return `Not a valid address or network: ${(invalid ?? []).join(", ")}`;
    case "invalid_webhook_url": return "The webhook URL must start with http:// or https://.";
    case "anchor_tsa_required": return "The external anchor needs a Time-Stamp Authority URL.";
    case "anchor_tsa_invalid": return "The TSA URL must start with http:// or https://.";
    case "invalid_timezone": return "That time zone isn't known. Pick one from the list.";
    case "own_session_lacks_second_factor": return "Your own sign-in has no second step, so requiring two-step verification would lock you out.";
    case "invalid_value": return "One value isn't allowed. Check the highlighted row.";
    case "forbidden": return "Only admins can change the policy.";
    default: return "Couldn't save. Try again.";
  }
}

export function PolicyView({ workspace, initial, fromEnv, hasTsaAuth, canRequireTwoStep, zoneLockedUrl, timeZones, cron }: {
  workspace: string | null;
  initial: PolicyValues;
  fromEnv: PolicyEnv;
  hasTsaAuth: boolean;
  canRequireTwoStep: boolean;
  zoneLockedUrl: string | null;
  timeZones: string[];
  cron: { anyRun: boolean; stale: string[] } | null;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [v, setV] = useState(initial);
  const [tsaAuth, setTsaAuth] = useState("");
  const [tsaClear, setTsaClear] = useState(false);
  const [tsaSaved, setTsaSaved] = useState(hasTsaAuth);
  const [busy, setBusy] = useState(false);
  const [errKey, setErrKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const set = useCallback(<K extends FlatKey>(k: K, val: PolicyValues[K]) => setV((x) => ({ ...x, [k]: val })), []);
  const setGuac = useCallback((k: keyof GuacFields, val: string) => setV((x) => ({ ...x, guac: { ...x.guac, [k]: val } })), []);

  const changedFlat = useMemo(() => (Object.keys(v) as (keyof PolicyValues)[]).filter((k) => k !== "guac" && v[k] !== saved[k]) as FlatKey[], [v, saved]);
  const changedGuac = useMemo(() => (Object.keys(v.guac) as (keyof GuacFields)[]).filter((k) => v.guac[k] !== saved.guac[k]), [v, saved]);
  const tsaChanged = tsaClear || tsaAuth.trim() !== "";
  const count = changedFlat.length + changedGuac.length + (tsaChanged ? 1 : 0);
  const dirty = count > 0;
  const perSection = useMemo(() => {
    const m = new Map<SectionId, number>();
    const add = (s: SectionId, n = 1) => m.set(s, (m.get(s) ?? 0) + n);
    for (const k of changedFlat) add(SECTION_OF[k]);
    if (changedGuac.length) add("connectors", changedGuac.length);
    if (tsaChanged) add("audit");
    return m;
  }, [changedFlat, changedGuac, tsaChanged]);
  const isChanged = (k: FlatKey) => changedFlat.includes(k);

  // Leaving with unsaved changes: the browser asks on reload/close; links inside
  // the console ask here first.
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; } };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onUnload); document.removeEventListener("click", onClick, true); };
  }, []);

  function revert() {
    setV(saved);
    setTsaAuth("");
    setTsaClear(false);
    setErrKey(null);
  }

  async function save() {
    const changes: Record<string, unknown> = {};
    for (const k of changedFlat) changes[k] = v[k];
    if (changedGuac.length) changes.guacParamDefaults = guacFieldsToParams(v.guac);
    if (tsaChanged) changes.anchorTsaAuth = tsaClear ? null : tsaAuth.trim();
    setBusy(true);
    setErrKey(null);
    try {
      const res = await fetch("/api/admin/policy", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || !r?.ok) {
        setToast({ msg: errorText(r?.error, r?.invalid), ok: false });
        if (r?.key) {
          setErrKey(r.key);
          document.getElementById(`pol-${r.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      setSaved(v);
      if (tsaChanged) setTsaSaved(!tsaClear);
      setTsaAuth("");
      setTsaClear(false);
      setToast({ msg: `${count} ${count === 1 ? "change" : "changes"} saved`, ok: true });
      router.refresh();
    } catch {
      setToast({ msg: errorText(undefined), ok: false });
    } finally {
      setBusy(false);
    }
  }

  const rowProps = (k: FlatKey) => ({ id: `pol-${k}`, changed: isChanged(k), error: errKey === k });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Infrastructure{workspace ? ` · ${workspace}` : ""}</div>
          <h1>Policy</h1>
          <p>Workspace-wide controls, applied to the console and to vendor sessions. Settings are stored in the database and some can also come from the environment; a value set here always wins.</p>
        </div>
      </div>

      {cron && (
        <div className={`notice ${cron.anyRun ? "warn" : ""}`} role="alert">
          {cron.anyRun ? (
            <><b>Some scheduled jobs look stopped:</b> {cron.stale.join(", ")}. The settings that rely on them won&apos;t take effect until they run again. Check the cron on your server.</>
          ) : (
            <><b>Background jobs haven&apos;t run yet.</b> If you deployed with <code>deploy/setup.sh</code> they are already scheduled and start shortly. Otherwise schedule the cron jobs on your server, or the retention and health settings won&apos;t take effect.</>
          )}
        </div>
      )}

      <nav className="pol-nav" aria-label="Policy sections">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="pol-pill">
            <Icon name={s.icon} />{s.title}
            {perSection.get(s.id) ? <span className="pol-pill-n" aria-label={`${perSection.get(s.id)} unsaved`}>{perSection.get(s.id)}</span> : null}
          </a>
        ))}
      </nav>

      <Section s={SECTIONS[0]}>
        <Row {...rowProps("idleTimeoutMinutes")} label="Idle timeout" desc="A session with no activity for this long is closed. Empty: no idle timeout.">
          <Num value={v.idleTimeoutMinutes} onChange={(x) => set("idleTimeoutMinutes", x)} unit="min" placeholder="—" />
        </Row>
        <Row {...rowProps("maxSessionHours")} label="Longest session" desc="How long a sign-in lasts at most, cookie included." env={fromEnv.maxSessionHours}>
          <Num value={v.maxSessionHours} onChange={(x) => set("maxSessionHours", x)} unit="hours" placeholder={fromEnv.maxSessionHours ?? "12"} />
        </Row>
        <Row {...rowProps("maxConcurrentPerUser")} label="Sessions per person" desc="Past this many, the oldest session is signed out. Empty: no limit.">
          <Num value={v.maxConcurrentPerUser} onChange={(x) => set("maxConcurrentPerUser", x)} unit="sessions" placeholder="∞" />
        </Row>
        <Row {...rowProps("requireSecondFactor")} label="Require two-step verification"
          desc={!canRequireTwoStep && !saved.requireSecondFactor
            ? "Your own sign-in has no second step, so turning this on would lock you out. Sign in with a passkey or your authenticator code first."
            : "Refuse sign-ins that don't prove a second factor (passkey, or password plus authenticator code)."}
          chip={!v.requireSecondFactor ? { text: "RECOMMENDED", tone: "warn" } : undefined}>
          <Switch on={v.requireSecondFactor} onChange={(x) => set("requireSecondFactor", x)} label="Require two-step verification"
            disabled={!canRequireTwoStep && !saved.requireSecondFactor} />
        </Row>
      </Section>

      <Section s={SECTIONS[1]}>
        <Row {...rowProps("maxGrantDays")} label="Longest grant" desc="No grant can be longer than this, and permanent grants are not allowed. Empty: no limit.">
          <Num value={v.maxGrantDays} onChange={(x) => set("maxGrantDays", x)} unit="days" placeholder="—" />
        </Row>
        <Row {...rowProps("inviteTtlHours")} label="Invite link lifetime" desc="How long a new invite link works. The invite dialog offers this as its default." env={fromEnv.inviteTtlHours}>
          <Num value={v.inviteTtlHours} onChange={(x) => set("inviteTtlHours", x)} unit="hours" placeholder={fromEnv.inviteTtlHours ?? "48"} />
        </Row>
        <Row {...rowProps("requireRequestJustification")} label="Require a reason on access requests" desc="Vendors must say why they need access when they request it.">
          <Switch on={v.requireRequestJustification} onChange={(x) => set("requireRequestJustification", x)} label="Require a reason on access requests" />
        </Row>
      </Section>

      <Section s={SECTIONS[2]}>
        <Row {...rowProps("defaultConnectorLogLevel")} label="Default log level"
          desc="Applies to connectors set to “Use default” on their page; a connector's own level wins. Save first, then “Reset all” returns every connector to this level.">
          <span className="pol-inline">
            <Seg value={v.defaultConnectorLogLevel} onChange={(x) => set("defaultConnectorLogLevel", x)} label="Default log level"
              options={[["debug", "Debug"], ["info", "Info"], ["warn", "Warn"], ["error", "Error"]]} />
            <ResetLogLevels disabled={isChanged("defaultConnectorLogLevel")} onDone={(m, ok) => setToast({ msg: m, ok })} />
          </span>
        </Row>
        <div className="pol-row pol-wide" id="pol-guac">
          {changedGuac.length > 0 && <span className="pol-dot" aria-hidden="true" />}
          <div className="pol-label">
            <span className="pol-label-t">Remote desktop defaults{changedGuac.length > 0 && <span className="pol-chip p">{changedGuac.length} · CHANGED</span>}</span>
            <span className="pol-desc">Default settings for RDP, VNC and SSH resources. Each resource can override them on its own form.</span>
          </div>
          <GuacTiles value={v.guac} saved={saved.guac} set={setGuac} />
        </div>
      </Section>

      <Section s={SECTIONS[3]}>
        <AllowlistRow {...rowProps("vendorIpAllowlist")} value={v.vendorIpAllowlist} onChange={(x) => set("vendorIpAllowlist", x)} />
        <Row {...rowProps("isolatedEgressDefault")} label="Isolated browser network access"
          desc="For isolated browser resources set to “Inherit”: where the browser may go besides the resource itself. The resource is always reachable.">
          <Seg value={v.isolatedEgressDefault} onChange={(x) => set("isolatedEgressDefault", x)} label="Isolated browser network access"
            options={[["strict", "Only the resource"], ["internet", "Resource + internet"], ["open", "Everything, internal network too"]]} />
        </Row>
      </Section>

      <Section s={SECTIONS[4]}>
        <Row {...rowProps("recordingMode")} label="Recording" env={fromEnv.recordingMode}
          desc="Off: no resource is recorded. Per resource: each resource decides on its form. Required: every resource is recorded and it can't be turned off."
          chip={v.recordingMode === "required" ? { text: "REQUIRED", tone: "bad" } : undefined}>
          <Seg value={v.recordingMode} onChange={(x) => set("recordingMode", x)} label="Recording" options={[["off", "Off"], ["per_resource", "Per resource"], ["required", "Required"]]} />
        </Row>
        <Row {...rowProps("recordingConsentRequired")} label="Ask for recording consent" env={fromEnv.recordingConsentRequired}
          desc="On recorded resources, vendors confirm once that the session is recorded before anything loads. The recording banner shows either way.">
          <Switch on={v.recordingConsentRequired} onChange={(x) => set("recordingConsentRequired", x)} label="Ask for recording consent" />
        </Row>
        <Row {...rowProps("watermarkDefault")} label="Screen watermark" env={fromEnv.watermarkDefault}
          desc="The vendor's email and the time are drawn over the session, so screenshots and photos show who it was. A resource can override it.">
          <Switch on={v.watermarkDefault} onChange={(x) => set("watermarkDefault", x)} label="Screen watermark" />
        </Row>
        <Row {...rowProps("clipboardDefault")} label="Clipboard" desc="For resources set to “Inherit”. Web apps block keyboard and menu copy/paste; remote desktops block the clipboard channel.">
          <Seg value={v.clipboardDefault} onChange={(x) => set("clipboardDefault", x)} label="Clipboard"
            options={[["allow", "Copy & paste"], ["no_copy", "Paste only"], ["no_paste", "Copy only"], ["none", "Block"]]} />
        </Row>
        <Row {...rowProps("isolatedFileTransferDefault")} label="Isolated browser file transfer" desc="For isolated browser resources set to “Inherit”.">
          <Seg value={v.isolatedFileTransferDefault} onChange={(x) => set("isolatedFileTransferDefault", x)} label="Isolated browser file transfer"
            options={[["none", "Off"], ["no_download", "Upload"], ["no_upload", "Download"], ["allow", "Both"]]} />
        </Row>
        <Row {...rowProps("webAppFileTransferDefault")} label="Web app file transfer" desc="For web app resources set to “Inherit”. Every transfer is logged.">
          <Seg value={v.webAppFileTransferDefault} onChange={(x) => set("webAppFileTransferDefault", x)} label="Web app file transfer"
            options={[["none", "Off"], ["no_download", "Upload"], ["no_upload", "Download"], ["allow", "Both"]]} />
        </Row>
        <Row {...rowProps("keystrokeLoggingMode")} label="Keystroke log" desc="Typed text on recorded sessions, searchable later. Password prompts stay hidden.">
          <Seg value={v.keystrokeLoggingMode} onChange={(x) => set("keystrokeLoggingMode", x)} label="Keystroke log"
            options={[["off", "Off"], ["per_resource", "Per resource"], ["required", "Required"]]} />
        </Row>
        <Row {...rowProps("displayTimezone")} label="Display time zone" desc={zoneLockedUrl ? "Set by your Captivo organisation." : "Times in the console and in recordings use this zone. Empty: each viewer's browser zone."}>
          {zoneLockedUrl ? (
            <span className="pol-locked"><span className="mono">{v.displayTimezone || "—"}</span> <a href={zoneLockedUrl}>Change on the account page</a></span>
          ) : (
            <select className="select pol-select" value={v.displayTimezone} onChange={(e) => set("displayTimezone", e.target.value)} aria-label="Display time zone">
              <option value="">Each viewer&apos;s browser zone</option>
              {timeZones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          )}
        </Row>
        <Row {...rowProps("recordingRetentionDays")} label="Keep recordings for" desc="Older recordings are deleted by their connector. Empty: kept until erased.">
          <Num value={v.recordingRetentionDays} onChange={(x) => set("recordingRetentionDays", x)} unit="days" placeholder="∞" />
        </Row>
      </Section>

      <Section s={SECTIONS[5]}>
        <Row {...rowProps("auditRetentionDays")} label="Keep the audit log for" desc="Older access events are removed by the retention job." env={fromEnv.auditRetentionDays}>
          <Num value={v.auditRetentionDays} onChange={(x) => set("auditRetentionDays", x)} unit="days" placeholder={fromEnv.auditRetentionDays ?? "730"} />
        </Row>
        <Row {...rowProps("externalAnchorEnabled")} label="External timestamp (RFC 3161)" desc="Each day's chain head is stamped by a Time-Stamp Authority, so the log's integrity can be shown to someone outside.">
          <Switch on={v.externalAnchorEnabled} onChange={(x) => set("externalAnchorEnabled", x)} label="External timestamp" />
        </Row>
        <div className={["pol-row pol-wide", errKey === "anchorTsaUrl" ? "err" : ""].join(" ")} id="pol-anchorTsaUrl">
          {(isChanged("anchorTsaUrl") || tsaChanged) && <span className="pol-dot" aria-hidden="true" />}
          <div className="pol-label">
            <span className="pol-label-t">Time-Stamp Authority{(isChanged("anchorTsaUrl") || tsaChanged) && <span className="pol-chip p">CHANGED</span>}</span>
            <span className="pol-desc">The TSA&apos;s URL, and a user:pass if it asks for one.</span>
          </div>
          <div className="pol-tsa">
            <input className="input mono" value={v.anchorTsaUrl} onChange={(e) => set("anchorTsaUrl", e.target.value)} placeholder="https://freetsa.org/tsr" aria-label="TSA URL" />
            <input className="input mono" type="password" autoComplete="off" value={tsaAuth} disabled={tsaClear}
              onChange={(e) => setTsaAuth(e.target.value)} aria-label="TSA user:pass"
              placeholder={tsaClear ? "will be removed" : tsaSaved ? "saved · type to replace" : "user:pass (optional)"} />
            {tsaSaved && (
              <button type="button" className="btn sm" onClick={() => { setTsaClear((x) => !x); setTsaAuth(""); }}>{tsaClear ? "Keep" : "Remove"}</button>
            )}
          </div>
        </div>
      </Section>

      <Section s={SECTIONS[6]}>
        <div className={["pol-row pol-wide", errKey === "notificationWebhookUrl" ? "err" : ""].join(" ")} id="pol-notificationWebhookUrl">
          {isChanged("notificationWebhookUrl") && <span className="pol-dot" aria-hidden="true" />}
          <div className="pol-label">
            <span className="pol-label-t">Webhook{isChanged("notificationWebhookUrl") && <span className="pol-chip p">CHANGED</span>}{fromEnv.notificationWebhookUrl && <span className="pol-chip">ENV</span>}</span>
            <span className="pol-desc">Resource up/down events are posted here as JSON (Slack, Teams or your own endpoint).</span>
          </div>
          <div className="pol-tsa">
            <input className="input mono" value={v.notificationWebhookUrl} onChange={(e) => set("notificationWebhookUrl", e.target.value)}
              placeholder={fromEnv.notificationWebhookUrl ?? "https://hooks.slack.com/services/…"} aria-label="Webhook URL" />
            <WebhookTest url={v.notificationWebhookUrl.trim() || fromEnv.notificationWebhookUrl || ""} onDone={(m, ok) => setToast({ msg: m, ok })} />
          </div>
        </div>
        {NOTIF_EVENTS.map((ev) => {
          const k = ev.key === "site_health" ? "notifySiteHealth" : ev.key === "access_requests" ? "notifyAccessRequests" : "notifyAccessDecisions";
          return (
            <Row key={k} {...rowProps(k)} label={`Email: ${ev.label.toLowerCase()}`} desc={ev.hint}>
              <Switch on={v[k]} onChange={(x) => set(k, x)} label={`Email: ${ev.label}`} />
            </Row>
          );
        })}
      </Section>

      {dirty && (
        <div className="pol-bar" role="region" aria-label="Unsaved changes">
          <span className="pol-bar-dot" aria-hidden="true" />
          <span className="pol-bar-n">{count} unsaved {count === 1 ? "change" : "changes"}</span>
          <button type="button" className="pol-bar-b" disabled={busy} onClick={revert}>Undo</button>
          <button type="button" className="pol-bar-b primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      )}

      <Modal open={leaveTo !== null} onClose={() => setLeaveTo(null)} title="Leave without saving?" subtitle={`${count} ${count === 1 ? "change is" : "changes are"} not saved yet.`} size="sm">
        <div className="rq-foot">
          <span className="rq-status" />
          <button type="button" className="btn" onClick={() => setLeaveTo(null)}>Stay</button>
          <button type="button" className="btn danger" onClick={() => { const to = leaveTo!; dirtyRef.current = false; setLeaveTo(null); router.push(to); }}>Leave</button>
        </div>
      </Modal>

      {toast && <div className="toast" role="status"><span className={toast.ok ? undefined : "t-bad"}>{toast.ok ? "✓" : "!"}</span>{toast.msg}</div>}
    </>
  );
}

/* ---------- building blocks ---------- */

function Section({ s, children }: { s: (typeof SECTIONS)[number]; children: React.ReactNode }) {
  return (
    <section className="pol-card" id={s.id} aria-labelledby={`${s.id}-t`}>
      <div className="pol-card-h">
        <span className="pol-ic" aria-hidden="true"><Icon name={s.icon} /></span>
        <span><b id={`${s.id}-t`}>{s.title}</b><span className="cell-sub">{s.sub}</span></span>
      </div>
      {children}
    </section>
  );
}

function Row({ id, label, desc, changed, error, env, chip, children }: {
  id: string; label: string; desc: string; changed: boolean; error: boolean; env?: string; chip?: { text: string; tone: "warn" | "bad" }; children: React.ReactNode;
}) {
  return (
    <div className={error ? "pol-row err" : "pol-row"} id={id}>
      {changed && <span className="pol-dot" aria-hidden="true" />}
      <div className="pol-label">
        <span className="pol-label-t">
          {label}
          {changed && <span className="pol-chip p">CHANGED</span>}
          {env !== undefined && !changed && <span className="pol-chip" title={`From the environment: ${env}`}>ENV</span>}
          {chip && <span className={`pol-chip ${chip.tone}`}>{chip.text}</span>}
        </span>
        <span className="pol-desc">{desc}</span>
      </div>
      <div className="pol-ctl">{children}</div>
    </div>
  );
}

function Num({ value, onChange, unit, placeholder }: { value: string; onChange: (v: string) => void; unit: string; placeholder: string }) {
  return (
    <span className="pol-num">
      <input className="input mono" inputMode="numeric" value={value} placeholder={placeholder} aria-label={unit}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))} />
      <span className="pol-unit">{unit}</span>
    </span>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={on ? "toggle on" : "toggle"} onClick={() => onChange(!on)}><span /></button>
  );
}

function Seg({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) {
  return (
    <div className="seg pol-seg" role="radiogroup" aria-label={label}>
      {options.map(([val, text]) => (
        <button key={val} type="button" role="radio" aria-checked={value === val} className={value === val ? "seg-opt on" : "seg-opt"} onClick={() => onChange(val)}>{text}</button>
      ))}
    </div>
  );
}

function AllowlistRow({ id, changed, error, value, onChange }: { id: string; changed: boolean; error: boolean; value: string; onChange: (v: string) => void }) {
  const { entries, invalid } = checkAllowlist(value);
  return (
    <div className={error || invalid.length ? "pol-row pol-wide err" : "pol-row pol-wide"} id={id}>
      {changed && <span className="pol-dot" aria-hidden="true" />}
      <div className="pol-label">
        <span className="pol-label-t">Vendor IP allowlist{changed && <span className="pol-chip p">CHANGED</span>}</span>
        <span className="pol-desc">Vendors may connect to resources only from these addresses or networks (CIDR), separated by commas or spaces. The console is never restricted.</span>
      </div>
      <textarea className={invalid.length ? "input mono pol-ta bad" : "input mono pol-ta"} rows={3} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="203.0.113.0/24, 198.51.100.7, 2001:db8::/32" aria-label="Vendor IP allowlist" aria-invalid={invalid.length > 0} />
      {entries.length > 0 && (
        <div className="pol-chips">{entries.map((e, i) => <span key={i} className={e.ok ? "pol-ip" : "pol-ip bad"}>{e.text}</span>)}</div>
      )}
      <span className={invalid.length ? "pol-status t-bad" : entries.length ? "pol-status t-ok" : "pol-status t-muted"}>
        {invalid.length ? `Not valid: ${invalid.join(", ")}` : entries.length ? `${entries.length} ${entries.length === 1 ? "network" : "networks"} · valid` : "No restriction. If you add one, include your own network too."}
      </span>
    </div>
  );
}

function ResetLogLevels({ disabled, onDone }: { disabled: boolean; onDone: (msg: string, ok: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/policy/connector-log-level/reset-all", { method: "POST" });
      const r = await res.json().catch(() => ({}));
      onDone(res.ok ? `${r.count ?? 0} ${r.count === 1 ? "connector" : "connectors"} back on the default level` : "Couldn't reset the connectors. Try again.", res.ok);
    } catch {
      onDone("Couldn't reset the connectors. Try again.", false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn sm" disabled={disabled || busy} title={disabled ? "Save the new level first" : undefined} onClick={() => void run()}>
      {busy ? "Resetting…" : "Reset all"}
    </button>
  );
}

function WebhookTest({ url, onDone }: { url: string; onDone: (msg: string, ok: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/policy/webhook-test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      const r = await res.json().catch(() => ({}));
      if (r.error === "private_address") onDone("That address is on a private network; the cloud service can't post there.", false);
      else if (r.error) onDone("Enter a valid http(s) URL.", false);
      else if (r.ok) onDone(`Test event delivered · HTTP ${r.status}`, true);
      else onDone(r.status ? `The webhook answered HTTP ${r.status}` : r.reason === "timeout" ? "The webhook didn't answer within 5 seconds" : "Couldn't reach the webhook", false);
    } catch {
      onDone("Couldn't send the test. Try again.", false);
    } finally {
      setBusy(false);
    }
  }
  return <button type="button" className="btn sm" disabled={!url || busy} onClick={() => void run()}>{busy ? "Sending…" : "Send test"}</button>;
}

/* ---------- remote desktop tiles ---------- */

type Opt = [string, string];
const tri = (def: string): Opt[] => [["", `Engine default (${def})`], ["on", "On"], ["off", "Off"]];
interface Tile { k: keyof GuacFields; label: string; options?: Opt[]; hint?: string; text?: string; when?: (g: GuacFields) => boolean }
const GROUPS: { tag: string; tone: string; title: string; tiles: Tile[] }[] = [
  { tag: "RDP", tone: "violet", title: "Display & input", tiles: [
    { k: "serverLayout", label: "Keyboard layout", options: KEYBOARD_LAYOUTS.map((l) => [l.value, l.value ? l.label : "Engine default (US English)"]) },
    { k: "rdpSecurity", label: "RDP security", options: [["", "Engine default (negotiate)"], ["nla", "NLA"], ["tls", "TLS"], ["rdp", "RDP (legacy)"]],
      hint: "If an up-to-date Windows server refuses the connection (“wrong security type”), pick NLA." },
    { k: "colorDepth", label: "Colour depth", options: [["", "Engine default (auto)"], ["24", "24-bit"], ["16", "16-bit"], ["8", "8-bit"]] },
    { k: "enableWallpaper", label: "Desktop wallpaper", options: tri("Off") },
    { k: "enableTheming", label: "Window theming", options: tri("Off") },
    { k: "enableFontSmoothing", label: "Font smoothing", options: tri("Off") },
    { k: "enableFullWindowDrag", label: "Full-window drag", options: tri("Off") },
    { k: "audio", label: "Sound", options: tri("On") },
    { k: "printing", label: "Printing", options: tri("Off") },
  ] },
  { tag: "FILE", tone: "warn", title: "File channel · RDP & SSH", tiles: [
    { k: "fileTransfer", label: "File transfer", options: tri("Off"), hint: "The main switch for files in RDP and SSH sessions." },
    { k: "blockUpload", label: "Block upload", options: [["", "Engine default (allowed)"], ["on", "Blocked"], ["off", "Allowed"]], when: (g) => g.fileTransfer !== "off" },
    { k: "blockDownload", label: "Block download", options: [["", "Engine default (allowed)"], ["on", "Blocked"], ["off", "Allowed"]], when: (g) => g.fileTransfer !== "off" },
    { k: "sftpRoot", label: "SFTP folder", text: "Auto (the user's home)", when: (g) => g.fileTransfer !== "off" },
  ] },
  { tag: "SSH", tone: "ok", title: "Terminal", tiles: [
    { k: "terminalFontSize", label: "Font size", options: [["", "Engine default (12 pt)"], ...["10", "12", "14", "16", "18", "20", "24"].map((n): Opt => [n, `${n} pt`])] },
    { k: "terminalColorScheme", label: "Colours", options: TERMINAL_COLOR_SCHEMES.map((c) => [c.value, c.value ? c.label : "Engine default (gray on black)"]) },
    { k: "terminalScrollback", label: "Scrollback", options: [["", "Engine default (1000 lines)"], ...["1000", "5000", "10000", "50000"].map((n): Opt => [n, `${Number(n).toLocaleString("en-US")} lines`])] },
  ] },
];

function GuacTiles({ value, saved, set }: { value: GuacFields; saved: GuacFields; set: (k: keyof GuacFields, v: string) => void }) {
  return (
    <div className="pol-groups">
      {GROUPS.map((g) => (
        <div key={g.tag} className="pol-group">
          <div className="pol-group-h"><span className={`pol-tag ${g.tone}`}>{g.tag}</span>{g.title}</div>
          <div className="pol-tiles">
            {g.tiles.filter((t) => !t.when || t.when(value)).map((t) => {
              const changed = value[t.k] !== saved[t.k];
              return (
                <label key={t.k} className={changed ? "pol-tile on" : "pol-tile"}>
                  <span className="pol-tile-l">{changed && <span className="pol-dot sm" aria-hidden="true" />}{t.label}</span>
                  {t.options ? (
                    <select className="select pol-select sm" value={value[t.k]} onChange={(e) => set(t.k, e.target.value)}>
                      {t.options.map(([val, text]) => <option key={val} value={val}>{text}</option>)}
                    </select>
                  ) : (
                    <input className="input mono pol-text" value={value[t.k]} placeholder={t.text} onChange={(e) => set(t.k, e.target.value)} />
                  )}
                  {t.hint && <span className="pol-hint">{t.hint}</span>}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- icons ---------- */

const PATHS: Record<string, string[]> = {
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  key: ["M8 15a4 4 0 1 0 0-.01z", "M11 12l9-9", "M17 6l3 3", "M15 8l2 2"],
  plug: ["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"],
  shield: ["M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"],
  video: ["M3 7h12v10H3z", "M15 10l6-3v10l-6-3"],
  list: ["M8 6h12", "M8 12h12", "M8 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  bell: ["M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z", "M10 20a2 2 0 0 0 4 0"],
};
function Icon({ name }: { name: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(PATHS[name] ?? []).map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
