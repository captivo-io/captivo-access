"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";
import { parseDatetimeLocal } from "@/lib/time/datetime-local";
import type { Schedule } from "@/lib/access/schedule";
import type { SiteTile } from "@/lib/access/grant-rows";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { Role } from "@/generated/prisma/enums";

export type GrantUser = { id: string; name: string; email: string; role: Role };
type Duration = "1h" | "4h" | "1d" | "1w" | "perm" | "custom";

const DURATIONS: { key: Duration; label: string; hours?: number }[] = [
  { key: "1h", label: "1 hour", hours: 1 },
  { key: "4h", label: "4 hours", hours: 4 },
  { key: "1d", label: "1 day", hours: 24 },
  { key: "1w", label: "1 week", hours: 168 },
  { key: "perm", label: "Permanent" },
  { key: "custom", label: "Pick end" },
];
const DAYS = [
  { i: 1, l: "Mon" }, { i: 2, l: "Tue" }, { i: 3, l: "Wed" }, { i: 4, l: "Thu" },
  { i: 5, l: "Fri" }, { i: 6, l: "Sat" }, { i: 0, l: "Sun" },
];

export function initials(name: string, email: string): string {
  const parts = (name || email).trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function RoleChip({ role }: { role: Role }) {
  return <span className={role === "VENDOR" ? "gr-role vendor" : "gr-role"}>{(ROLE_LABELS[role] ?? role).toUpperCase()}</span>;
}

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_date": return "Start and end must be valid dates.";
    case "invalid_user": return "Pick a valid user.";
    case "invalid_site": return "One of the resources no longer exists.";
    case "invalid_schedule": return "Pick at least one day, and an end time after the start.";
    case "grant_requires_end": return "Policy requires an end date: permanent grants aren't allowed here.";
    case "grant_exceeds_max": return "This grant is longer than the maximum duration the policy allows.";
    case "forbidden": return "You can't grant access.";
    default: return "Couldn't grant access. Try again.";
  }
}

/**
 * The "New grant" dialog of the design hand-off: one user, one or more
 * resources, a window and optional recurring hours. One grant per resource.
 */
export function GrantDialogBody({
  users, sites, has, maxGrantDays, initialUserId, initialSiteIds, onDone, onClose,
}: {
  users: GrantUser[];
  sites: SiteTile[];
  /** "userId siteId" pairs that already have a live grant. */
  has: Set<string>;
  maxGrantDays: number;
  initialUserId?: string | null;
  initialSiteIds?: string[];
  onDone: (n: number, userId: string) => void;
  onClose: () => void;
}) {
  const tz = useTimezone();
  const zone = tz ?? browserZone();
  const [userId, setUserId] = useState<string | null>(initialUserId ?? null);
  const [siteIds, setSiteIds] = useState<string[]>(initialSiteIds ?? []);
  const [q, setQ] = useState("");
  const [later, setLater] = useState(false);
  const [from, setFrom] = useState("");
  const [duration, setDuration] = useState<Duration>("1d");
  const [until, setUntil] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = users.find((u) => u.id === userId) ?? null;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? sites.filter((s) => `${s.name} ${s.host ?? ""} ${s.proto}`.toLowerCase().includes(t)) : sites;
  }, [q, sites]);

  // Under a "max grant duration" policy, nothing permanent and nothing longer.
  const allowed = (d: (typeof DURATIONS)[number]) =>
    maxGrantDays <= 0 || d.key === "custom" || (d.hours !== undefined && d.hours <= maxGrantDays * 24);
  const durLabel = duration === "custom" ? "until the end you pick" : DURATIONS.find((d) => d.key === duration)!.label;
  const ready = !!user && siteIds.length > 0;
  const summary = ready
    ? `${user!.name || user!.email} · ${siteIds.length} ${siteIds.length === 1 ? "resource" : "resources"} · ${durLabel} · ${later ? "starts later" : "starts now"}`
    : "Pick a user and at least one resource.";

  async function submit() {
    setError(null);
    const startsAt = later ? parseDatetimeLocal(from, tz) : null;
    if (later && !startsAt) { setError("Pick when the access starts."); return; }
    const base = startsAt ?? new Date();
    let endsAt: Date | null = null;
    if (duration === "custom") {
      endsAt = parseDatetimeLocal(until, tz);
      if (!endsAt) { setError("Pick when the access ends."); return; }
      if (endsAt <= base) { setError("The end must be after the start."); return; }
    } else if (duration !== "perm") {
      endsAt = new Date(base.getTime() + DURATIONS.find((d) => d.key === duration)!.hours! * 3_600_000);
    }
    const schedule: Schedule | undefined = recurring ? { timezone: zone, days, start, end } : undefined;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId, siteIds,
          startsAt: startsAt?.toISOString() ?? null,
          endsAt: endsAt?.toISOString() ?? null,
          note: note.trim() || undefined,
          schedule,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body?.ids)) { setError(errorMessage(body?.error)); return; }
      onDone(body.ids.length, userId!);
    } catch {
      setError(errorMessage(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rq gd" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
      <div className="rq-sec">
        <div className="rq-label"><span>User</span><Link href="/admin/invites" className="gd-invite">+ Invite vendor</Link></div>
        <div className="gd-users" role="radiogroup" aria-label="User">
          {users.map((u) => (
            <button key={u.id} type="button" role="radio" aria-checked={u.id === userId} className={u.id === userId ? "gd-user on" : "gd-user"} onClick={() => setUserId(u.id)}>
              <span className="gr-av sm" aria-hidden="true">{initials(u.name, u.email)}</span>
              <span className="gd-user-t">
                <span className="gd-user-n">{u.name || u.email}<RoleChip role={u.role} /></span>
                <span className="mono t-muted">{u.email}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="rq-sec">
        <div className="rq-label"><span>Resources</span><span className="mono t-muted">{siteIds.length ? `${siteIds.length} selected` : "pick one or more"}</span></div>
        <label className="ma-search gd-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search resources…" aria-label="Search resources" />
        </label>
        <div className="rq-list gd-res">
          {shown.length === 0 && <div className="rq-empty">No resource matches.</div>}
          {shown.map((s) => {
            const on = siteIds.includes(s.id);
            return (
              <label key={s.id} className={on ? "gd-res-row on" : "gd-res-row"}>
                <input type="checkbox" checked={on} onChange={() => setSiteIds((v) => (on ? v.filter((x) => x !== s.id) : [...v, s.id]))} />
                <span className={s.remote ? "rs-proto sm remote" : "rs-proto sm"} aria-hidden="true">{s.proto}</span>
                <span className="rq-opt-main"><b>{s.name}</b>{s.host && <span className="mono t-muted">{s.host}</span>}</span>
                {userId && has.has(`${userId} ${s.id}`) && <span className="cell-sub">already has access</span>}
              </label>
            );
          })}
        </div>
      </div>

      <div className="rq-sec">
        <div className="rq-label"><span>Start</span><span className="mono t-muted">{zone}</span></div>
        <div className="gd-start">
          <div className="seg" role="group" aria-label="Start">
            <button type="button" className={later ? "seg-opt" : "seg-opt on"} aria-pressed={!later} onClick={() => setLater(false)}>Now</button>
            <button type="button" className={later ? "seg-opt on" : "seg-opt"} aria-pressed={later} onClick={() => setLater(true)}>Later</button>
          </div>
          {later && <input className="input gd-dt" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Starts at" />}
        </div>
      </div>

      <div className="rq-sec">
        <div className="rq-label"><span>Duration</span>{maxGrantDays > 0 && <span className="mono t-muted">policy: up to {maxGrantDays} {maxGrantDays === 1 ? "day" : "days"}</span>}</div>
        <div className="rq-pills" role="group" aria-label="Duration">
          {DURATIONS.map((d) => {
            const ok = allowed(d);
            return (
              <button key={d.key} type="button" disabled={!ok} title={ok ? undefined : "Longer than the policy allows"}
                className={duration === d.key ? "fpill on" : "fpill"} aria-pressed={duration === d.key} onClick={() => setDuration(d.key)}>
                {d.label}
              </button>
            );
          })}
        </div>
        {duration === "custom" && <input className="input gd-dt" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Ends at" />}
        {duration === "perm" && user?.role === "VENDOR" && (
          <p className="gd-warn" role="status"><b>!</b>Permanent access is not recommended for vendors.</p>
        )}
      </div>

      <div className="rq-sec gd-rec">
        <div className="rq-row">
          <span className="rq-label-plain">Recurring hours<span className="cell-sub">Only on these days and times</span></span>
          <button type="button" role="switch" aria-checked={recurring} aria-label="Recurring hours" className={recurring ? "toggle on" : "toggle"} onClick={() => setRecurring((v) => !v)}>
            <span />
          </button>
        </div>
        {recurring && (
          <div className="rq-rec">
            <div className="rq-days" role="group" aria-label="Days">
              {DAYS.map((d) => (
                <button key={d.i} type="button" aria-pressed={days.includes(d.i)} className={days.includes(d.i) ? "day on" : "day"}
                  onClick={() => setDays((v) => (v.includes(d.i) ? v.filter((x) => x !== d.i) : [...v, d.i]))}>
                  {d.l}
                </button>
              ))}
            </div>
            <div className="rq-times">
              <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="From" />
              <span className="t-muted">–</span>
              <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Until" />
            </div>
          </div>
        )}
      </div>

      <label className="rq-sec">
        <span className="rq-label"><span>Note <span className="t-muted gd-opt">(optional)</span></span></span>
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. ticket number, task…" />
      </label>

      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="rq-foot">
        <span className={ready ? "rq-status" : "rq-status t-muted"}>{summary}</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !ready}>{busy ? "Granting…" : "Grant access"}</button>
      </div>
    </form>
  );
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
