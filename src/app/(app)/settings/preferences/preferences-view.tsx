"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { timeZoneList } from "@/app/(app)/_shell/timezone-select";
import { setTheme, useTheme } from "@/components/theme-switcher";
import { DISPLAY_NAME_MAX } from "@/lib/auth/display-name";
import { AccountHead } from "../account-head";

/** "Wed 15:48" and "UTC+03:00" for a zone, for the "Now" line under the picker. */
function nowIn(tz: string | null, at: Date): { time: string; offset: string } {
  try {
    const opts: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) };
    const time = at.toLocaleString("en-GB", opts);
    const off = new Intl.DateTimeFormat("en-GB", { timeZoneName: "longOffset", ...(tz ? { timeZone: tz } : {}) })
      .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
    return { time, offset: off.replace("GMT", "UTC") || "UTC" };
  } catch {
    return { time: "", offset: "" };
  }
}

/**
 * Preferences tab of My account (design hand-offs 7.21 and 11, 7.24): profile,
 * display, and — for a Captivo ID account — where sign-in security lives. One
 * save bar for name and time zone; the theme applies at once.
 */
export function PreferencesView({ view, workspace, recoveryOn, idLinked, accountUrl, email, name, nameLocked, timezone, orgTimezone, serverNow }: {
  view: "admin" | "user";
  workspace: string | null;
  recoveryOn: boolean;
  idLinked: boolean;
  accountUrl: string | null;
  email: string;
  name: string;
  nameLocked: boolean;
  timezone: string;
  orgTimezone: string | null;
  serverNow: string;
}) {
  const router = useRouter();
  const theme = useTheme();
  const [saved, setSaved] = useState({ name, timezone });
  const [n, setN] = useState(name);
  const [tz, setTz] = useState(timezone);
  const [zones, setZones] = useState<string[]>(() => (timezone ? [timezone] : []));
  const [now, setNow] = useState(() => new Date(serverNow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    // The browser's zone list and clock: client-only, so the first render matches the server's.
    setZones(timeZoneList());
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const nameCh = !nameLocked && n.trim() !== saved.name;
  const tzCh = tz !== saved.timezone;
  const nameBad = nameCh && !n.trim();
  const dirty = (nameCh ? 1 : 0) + (tzCh ? 1 : 0);
  const shown = nowIn(tz || orgTimezone, now);

  async function save() {
    if (nameBad) return;
    setBusy(true);
    setError(null);
    try {
      if (nameCh) {
        const res = await fetch("/api/settings/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n.trim() }) });
        const b = await res.json().catch(() => ({}));
        if (!res.ok) { setError(b?.error === "directory_managed" ? "Your name is managed by your organization's directory." : "Enter a name (up to 100 characters)."); return; }
      }
      if (tzCh) {
        const res = await fetch("/api/settings/timezone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timezone: tz || undefined }) });
        if (!res.ok) { setError("That time zone isn't recognised."); return; }
      }
      setSaved({ name: nameLocked ? saved.name : n.trim(), timezone: tz });
      setToast("Preferences saved");
      router.refresh();
    } catch {
      setError("Couldn't save, please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ac">
      <AccountHead tab="prefs" title="Preferences" workspace={workspace} recoveryOn={recoveryOn} prefsHref={view === "admin" ? "/settings/preferences" : "/preferences"}
        sub="Your personal display settings for this account." />
      {error && <p className="notice error" role="alert">{error}</p>}

      <section className="pol-card">
        <div className="pol-card-h"><span className="pol-ic"><NavIcon name="users" size={16} /></span><span><b>Profile</b><span className="cell-sub">Admins see you by this name.</span></span></div>
        <div className="pol-row">
          {nameCh && <span className="pol-dot" aria-hidden="true" />}
          <div className="pol-label"><span className="pol-label-t">Display name</span><span className="pol-desc">How you&apos;re greeted and shown to admins and vendors.</span></div>
          <div className="ac-ctl">
            <input className={nameBad ? "input bad" : "input"} value={n} maxLength={DISPLAY_NAME_MAX} disabled={nameLocked} onChange={(e) => setN(e.target.value)} aria-label="Display name" autoComplete="name" />
            {nameLocked && <span className="cell-sub">Managed by your organization&apos;s directory.</span>}
            {nameBad && <span className="ac-err">Name can&apos;t be empty.</span>}
          </div>
        </div>
        <div className="pol-row">
          <div className="pol-label"><span className="pol-label-t">Email</span><span className="pol-desc">{idLinked ? "Comes from your Captivo ID account; it can't be changed here." : "Your sign-in address; an admin can change it."}</span></div>
          <div className="ac-ctl"><span className="ac-ro mono">{email}{idLinked && <span className="pol-chip">CAPTIVO ID</span>}</span></div>
        </div>
      </section>

      <section className="pol-card">
        <div className="pol-card-h"><span className="pol-ic"><NavIcon name="clock" size={16} /></span><span><b>Display</b><span className="cell-sub">Time zone and theme.</span></span></div>
        <div className="pol-row">
          {tzCh && <span className="pol-dot" aria-hidden="true" />}
          <div className="pol-label"><span className="pol-label-t">Time zone</span><span className="pol-desc">Dates and times you see, and the times you type when requesting access, use this time zone. The organization default follows the setting chosen by your administrator.</span></div>
          <div className="ac-ctl">
            <select className="select" value={tz} onChange={(e) => setTz(e.target.value)} aria-label="Time zone">
              <option value="">Organization default{orgTimezone ? ` (${orgTimezone})` : ""}</option>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <span className="ac-now"><span className="ac-now-dot" /><span className="cell-sub">Now</span><b className="mono">{shown.time}</b><span className="mono cell-sub ac-now-off">{shown.offset}</span></span>
          </div>
        </div>
        <div className="pol-row">
          <div className="pol-label"><span className="pol-label-t">Theme</span><span className="pol-desc">Applies immediately; shared with Captivo Portal and Captivo ID on this browser.</span></div>
          <div className="ac-ctl">
            <div className="seg" role="radiogroup" aria-label="Theme">
              {(["light", "dark"] as const).map((t) => (
                <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? "seg-opt on" : "seg-opt"} onClick={() => setTheme(t)}>{t === "light" ? "Light" : "Dark"}</button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {idLinked && accountUrl && (
        <section className="pol-card">
          <div className="pol-row ac-sec">
            <span className="pol-ic"><NavIcon name="lock" size={16} /></span>
            <div className="pol-label"><span className="pol-label-t">Password and two-step verification</span><span className="pol-desc">Your Captivo ID sign-in security is managed in your Captivo ID account.</span></div>
            <a className="btn" href={accountUrl} target="_blank" rel="noopener noreferrer">Captivo ID <NavIcon name="ext" size={14} /></a>
          </div>
        </section>
      )}

      {dirty > 0 && (
        <div className="pol-bar" role="status">
          <span className="pol-bar-dot" aria-hidden="true" />
          <span className="pol-bar-n">{dirty} unsaved change{dirty === 1 ? "" : "s"}</span>
          <button type="button" className="pol-bar-b" onClick={() => { setN(saved.name); setTz(saved.timezone); }}>Undo</button>
          <button type="button" className="pol-bar-b primary" disabled={busy || nameBad} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      )}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}
