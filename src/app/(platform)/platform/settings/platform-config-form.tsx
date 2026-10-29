"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TimezoneSelect } from "@/app/(app)/_shell/timezone-select";
import { TimezoneHint } from "@/app/(app)/_shell/effective-timezone";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";
import { formatDatetimeLocal, parseDatetimeLocal } from "@/lib/time/datetime-local";

type Defaults = { recordingMode: string; keystrokeLoggingMode: string; auditRetentionDays: string; recordingRetentionDays: string; maxGrantDays: string; requireRequestJustification: boolean | null; displayTimezone: string };
type Initial = { announcementText: string; announcementLevel: string; announcementUntil: string; opsEmail: string; smtpFallback: boolean; signupEnabled: boolean; defaults: Defaults };

export function PlatformConfigForm({ initial, platformSmtp, signupUrl }: { initial: Initial; platformSmtp: { enabled: boolean; host: string } | null; signupUrl: string | null }) {
  const router = useRouter();
  const tz = useTimezone();
  // `announcementUntil` arrives as an ISO instant and is edited as a wall time in
  // the display zone (or the browser's when none is set) -- the zone the hint
  // names. Converted after mount: the server does not know the browser's zone.
  const [s, setS] = useState({ ...initial, announcementUntil: "" });
  useEffect(() => {
    if (initial.announcementUntil) setS((p) => ({ ...p, announcementUntil: formatDatetimeLocal(new Date(initial.announcementUntil), tz) }));
  }, [initial.announcementUntil, tz]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<Initial>) => setS((p) => ({ ...p, ...patch }));
  const setD = (patch: Partial<Defaults>) => setS((p) => ({ ...p, defaults: { ...p.defaults, ...patch } }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const until = s.announcementUntil ? parseDatetimeLocal(s.announcementUntil, tz) : null;
      if (s.announcementUntil && !until) { setMsg({ ok: false, text: "Couldn't save (invalid_until)." }); return; }
      const res = await fetch("/api/platform/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...s, announcementUntil: until ? until.toISOString() : "" }) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: `Couldn't save (${b?.error ?? res.status}).` }); return; }
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save}>
      <div className="card">
        <div className="card-head"><div><h2>Announcement</h2><div className="sub">A banner shown at the top of every tenant console and vendor portal. Leave the text empty to show nothing.</div></div></div>
        <div className="settings">
          <div className="setting setting-stack"><div className="setting-main"><span className="setting-label">Message</span></div><div className="setting-ctl"><input className="input" style={{ width: "100%" }} maxLength={300} placeholder="e.g. Maintenance window Saturday 02:00–03:00 UTC — sessions may drop briefly." value={s.announcementText} onChange={(e) => set({ announcementText: e.target.value })} /></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Severity</span></div><div className="setting-ctl"><select className="select" value={s.announcementLevel} onChange={(e) => set({ announcementLevel: e.target.value })}><option value="info">Info</option><option value="warn">Warning</option><option value="danger">Critical</option></select></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Show until</span><div className="setting-hint">Optional. The banner disappears automatically after this time.<TimezoneHint /></div></div><div className="setting-ctl"><input className="input" type="datetime-local" value={s.announcementUntil} onChange={(e) => set({ announcementUntil: e.target.value })} /></div></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>New tenant defaults</h2><div className="sub">Applied to a tenant&apos;s policy when it is created. Existing tenants are not changed. Empty = the product default.</div></div></div>
        <div className="settings">
          <div className="setting"><div className="setting-main"><span className="setting-label">Recording mode</span></div><div className="setting-ctl"><select className="select" value={s.defaults.recordingMode} onChange={(e) => setD({ recordingMode: e.target.value })}><option value="">Product default (per resource)</option><option value="off">Off</option><option value="per_resource">Per resource</option><option value="required">Required</option></select></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Keystroke logging</span></div><div className="setting-ctl"><select className="select" value={s.defaults.keystrokeLoggingMode} onChange={(e) => setD({ keystrokeLoggingMode: e.target.value })}><option value="">Product default (per resource)</option><option value="off">Off</option><option value="per_resource">Per resource</option><option value="required">Required</option></select></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Audit retention</span></div><div className="setting-ctl"><input className="input" type="number" min={0} placeholder="730" value={s.defaults.auditRetentionDays} onChange={(e) => setD({ auditRetentionDays: e.target.value })} /><span className="unit">days</span></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Recording retention</span></div><div className="setting-ctl"><input className="input" type="number" min={0} placeholder="∞" value={s.defaults.recordingRetentionDays} onChange={(e) => setD({ recordingRetentionDays: e.target.value })} /><span className="unit">days</span></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Maximum grant duration</span></div><div className="setting-ctl"><input className="input" type="number" min={0} placeholder="∞" value={s.defaults.maxGrantDays} onChange={(e) => setD({ maxGrantDays: e.target.value })} /><span className="unit">days</span></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Access-request justification</span></div><div className="setting-ctl"><select className="select" value={s.defaults.requireRequestJustification === null ? "" : s.defaults.requireRequestJustification ? "1" : "0"} onChange={(e) => setD({ requireRequestJustification: e.target.value === "" ? null : e.target.value === "1" })}><option value="">Product default (required)</option><option value="1">Required</option><option value="0">Optional</option></select></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Display timezone</span></div><div className="setting-ctl"><TimezoneSelect value={s.defaults.displayTimezone} onChange={(v) => setD({ displayTimezone: v })} inheritLabel="Each viewer's browser" /></div></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>Operations</h2></div></div>
        <div className="settings">
          <div className="setting"><div className="setting-main"><span className="setting-label">Ops email</span><div className="setting-hint">Receives the daily platform-ops digest when there are alerts (stale jobs, provisioning problems, expiring certificates, trials ending). Sent through the platform tenant&apos;s SMTP.</div></div><div className="setting-ctl"><input className="input" type="email" style={{ minWidth: 260 }} value={s.opsEmail} onChange={(e) => set({ opsEmail: e.target.value })} /></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">SMTP fallback for tenants</span><div className="setting-hint">Tenants that have not configured their own mail server send invites and notifications through the platform tenant&apos;s SMTP{platformSmtp ? ` (${platformSmtp.host}, ${platformSmtp.enabled ? "enabled" : "disabled"})` : " — not configured yet: set it up under the platform tenant's Email settings first"}.</div></div><div className="setting-ctl"><label className="switch"><input type="checkbox" checked={s.smtpFallback} onChange={(e) => set({ smtpFallback: e.target.checked })} /><span className="track" /></label></div></div>
          <div className="setting"><div className="setting-main"><span className="setting-label">Self-service signup</span><div className="setting-hint">Lets anyone create a 14-day trial tenant at {signupUrl ? <code>{signupUrl}</code> : "the platform host"} after verifying their email. Off by default.</div></div><div className="setting-ctl"><label className="switch"><input type="checkbox" checked={s.signupEnabled} onChange={(e) => set({ signupEnabled: e.target.checked })} /><span className="track" /></label></div></div>
        </div>
      </div>

      <div className="row-actions">
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
        {msg && <span className={msg.ok ? "cell-sub" : "notice error"}>{msg.text}</span>}
        <span className="cell-sub">Platform tenant mail, SSO and policy live in the <Link href="/admin/email" className="link-button">regular admin pages</Link> of the platform host.</span>
      </div>
    </form>
  );
}
