"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PLANS, LIMIT_KEYS, LIMIT_LABELS, CAPABILITY_KEYS, CAPABILITY_LABELS, type TenantLimits, type TenantCapabilities } from "@/lib/platform/tenant-shape";
import { TimezoneHint } from "@/app/(app)/_shell/effective-timezone";

type T = { id: string; name: string; plan: string; trialEndsAt: string; limits: TenantLimits; capabilities: TenantCapabilities; notes: string };
type Tri = "default" | "on" | "off";

export function TenantSettingsForm({ tenant }: { tenant: T }) {
  const router = useRouter();
  const [name, setName] = useState(tenant.name);
  const [plan, setPlan] = useState(tenant.plan);
  const [trialEndsAt, setTrialEndsAt] = useState(tenant.trialEndsAt);
  const [limits, setLimits] = useState<Record<string, string>>(Object.fromEntries(LIMIT_KEYS.map((k) => [k, tenant.limits[k]?.toString() ?? ""])));
  const [caps, setCaps] = useState<Record<string, Tri>>(Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, tenant.capabilities[k] === undefined ? "default" : tenant.capabilities[k] ? "on" : "off"])));
  const [notes, setNotes] = useState(tenant.notes);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const capabilities: Record<string, boolean> = {};
      for (const k of CAPABILITY_KEYS) if (caps[k] !== "default") capabilities[k] = caps[k] === "on";
      const res = await fetch(`/api/platform/tenants/${tenant.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, plan, trialEndsAt: null, limits, capabilities, notes }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: `Couldn't save (${b?.error ?? res.status}).` }); return; }
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save}>
      <div className="settings">
        <div className="setting"><div className="setting-main"><span className="setting-label">Display name</span><div className="setting-hint">Shown in the platform console and in the tenant&apos;s own console header.</div></div><div className="setting-ctl"><input className="input" style={{ minWidth: 260 }} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></div></div>
        <div className="setting"><div className="setting-main"><span className="setting-label">Plan</span><div className="setting-hint">Trial tenants are suspended automatically when the trial ends (platform-ops cron).</div></div><div className="setting-ctl">
          <select className="select" value={plan} onChange={(e) => setPlan(e.target.value)}>{PLANS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </div></div>
        {LIMIT_KEYS.map((k) => (
          <div className="setting" key={k}><div className="setting-main"><span className="setting-label">{LIMIT_LABELS[k]}</span><div className="setting-hint">{k === "maxRecordingRetentionDays" ? "Caps the tenant's own recording-retention policy." : "Empty = unlimited. Enforced when the tenant tries to add one more."}</div></div><div className="setting-ctl"><input className="input" type="number" min={1} placeholder="∞" value={limits[k]} onChange={(e) => setLimits((s) => ({ ...s, [k]: e.target.value }))} /></div></div>
        ))}
        {CAPABILITY_KEYS.map((k) => (
          <div className="setting" key={k}><div className="setting-main"><span className="setting-label">{CAPABILITY_LABELS[k]}</span><div className="setting-hint">Deployment default follows the server flag; forcing off hides the feature for this tenant.</div></div><div className="setting-ctl">
            <select className="select" value={caps[k]} onChange={(e) => setCaps((s) => ({ ...s, [k]: e.target.value as Tri }))}><option value="default">Deployment default</option><option value="on">Enabled</option><option value="off">Disabled</option></select>
          </div></div>
        ))}
        <div className="setting setting-stack"><div className="setting-main"><span className="setting-label">Operator notes</span><div className="setting-hint">Internal. Never shown to the tenant.</div></div><div className="setting-ctl"><textarea className="textarea" style={{ width: "100%", minHeight: 90 }} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} /></div></div>
      </div>
      <div className="row-actions" style={{ marginTop: 14 }}>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        {msg && <span className={msg.ok ? "cell-sub" : "notice error"}>{msg.text}</span>}
      </div>
    </form>
  );
}
