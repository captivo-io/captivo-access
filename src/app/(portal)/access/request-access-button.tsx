"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { useTimezone } from "@/app/(app)/_shell/timezone-context";
import { parseDatetimeLocal } from "@/lib/time/datetime-local";
import type { Schedule } from "@/lib/access/schedule";

type TicketMode = "off" | "required" | "itsm";
type Site = { id: string; name: string; hostname: string | null; accessMode: string; ticket?: TicketMode };
type Ticketing = { system: string; kind: string; checked: boolean };
type Preset = "1h" | "4h" | "1d" | "1w" | "custom";

const PRESETS: { key: Preset; label: string; hours?: number }[] = [
  { key: "1h", label: "1 hour", hours: 1 },
  { key: "4h", label: "4 hours", hours: 4 },
  { key: "1d", label: "1 day", hours: 24 },
  { key: "1w", label: "1 week", hours: 168 },
  { key: "custom", label: "Custom range" },
];
const DAYS = [
  { i: 1, l: "Mon" }, { i: 2, l: "Tue" }, { i: 3, l: "Wed" }, { i: 4, l: "Thu" },
  { i: 5, l: "Fri" }, { i: 6, l: "Sat" }, { i: 0, l: "Sun" },
];
const MIN_JUSTIFICATION = 10;

/** "+ Request access" and the request dialog of the design hand-off. */
export function RequestAccessButton({ requireJustification = true }: { requireJustification?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        + Request access
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Request access" subtitle="Your request goes to this workspace's approvers. You are told when it is decided." size="md">
        {open && <RequestDialogBody onClose={() => setOpen(false)} requireJustification={requireJustification} />}
      </Modal>
    </>
  );
}

function RequestDialogBody({ onClose, requireJustification }: { onClose: () => void; requireJustification: boolean }) {
  const router = useRouter();
  const tz = useTimezone();
  const zone = tz ?? browserZone();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [ticketing, setTicketing] = useState<Ticketing | null>(null);
  const [ticket, setTicket] = useState("");
  const [q, setQ] = useState("");
  const [siteId, setSiteId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("4h");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/access/sites")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { sites: Site[]; ticketing?: Ticketing }) => { setSites(d.sites); setTicketing(d.ticketing ?? null); })
      .catch(() => { setSites([]); setError("Could not load the list of resources."); });
  }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (sites ?? []).filter((x) => !s || x.name.toLowerCase().includes(s) || (x.hostname ?? "").toLowerCase().includes(s));
  }, [sites, q]);

  const whyOk = !requireJustification || why.trim().length >= MIN_JUSTIFICATION;
  const chosen = sites?.find((s) => s.id === siteId) ?? null;
  const ticketMode: TicketMode = chosen?.ticket ?? "off";
  const needsTicket = ticketMode !== "off";
  const missing = [!siteId && "resource", needsTicket && !ticket.trim() && "ticket", !whyOk && "justification", recurring && days.length === 0 && "days"].filter(Boolean) as string[];
  const hours = PRESETS.find((p) => p.key === preset)?.hours;

  async function submit() {
    if (!siteId || missing.length > 0) return;
    setError(null);
    let startsAt: string | undefined;
    let endsAt: string | undefined;
    if (preset === "custom") {
      const f = from ? parseDatetimeLocal(from, tz) : null;
      const u = until ? parseDatetimeLocal(until, tz) : null;
      if ((from && !f) || (until && !u)) { setError("Enter valid dates."); return; }
      startsAt = f?.toISOString();
      endsAt = u?.toISOString();
    } else if (hours) {
      const now = new Date();
      startsAt = now.toISOString();
      endsAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
    }
    const schedule: Schedule | undefined = recurring ? { timezone: zone, days, start, end } : undefined;
    setBusy(true);
    try {
      const res = await fetch("/api/access/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId, note: why.trim(), startsAt, endsAt, schedule, ticket: needsTicket ? ticket.trim() : undefined }),
      });
      if (res.status === 409) { setError("You already have access to this resource, or a request for it is waiting."); return; }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        if (typeof b.error === "string" && b.error.startsWith("ticket_") && b.message) { setError(b.message); return; }
        if (b.error === "grant_requires_end") { setError("Set an end: permanent access isn't allowed here."); return; }
        if (b.error === "grant_exceeds_max") { setError("That is longer than this workspace allows."); return; }
        if (b.error === "invalid_schedule") { setError("Check the recurring hours: the end must be after the start."); return; }
        setError("Could not send the request. Check the fields and try again.");
        return;
      }
      const ok = (await res.json().catch(() => ({}))) as { approved?: boolean };
      onClose();
      router.push(ok.approved ? "/requests?sent=1&approved=1" : "/requests?sent=1");
      router.refresh();
    } catch {
      setError("Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rq" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="rq-sec">
        <div className="rq-label"><span>Resource</span><span className="mono t-muted">{siteId ? "1 selected" : `${sites?.length ?? 0} available`}</span></div>
        <input className="input" type="search" placeholder="Search resources…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search resources" />
        <div className="rq-list" role="listbox" aria-label="Resource">
          {sites === null ? (
            <div className="rq-empty">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="rq-empty">{sites.length === 0 ? "Nothing to request: you already have access to every resource." : "No resource matches."}</div>
          ) : shown.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={siteId === s.id}
              className={siteId === s.id ? "rq-opt on" : "rq-opt"}
              onClick={() => setSiteId(s.id)}
            >
              <span className="rq-radio" aria-hidden="true" />
              <span className="rq-opt-main">
                <b>{s.name}</b>
                {s.hostname && <span className="mono t-muted">{s.hostname}</span>}
              </span>
              {s.ticket && s.ticket !== "off" && <span className="chip" title="Needs a ticket number">TICKET</span>}
              <span className={s.accessMode === "GATEWAY" ? "chip violet" : "chip"}>{s.accessMode === "GATEWAY" ? "REMOTE" : s.accessMode === "DATABASE" ? "DB" : "WEB"}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rq-sec">
        <div className="rq-label"><span>Duration</span><span className="mono t-muted">{zone}</span></div>
        <div className="rq-pills" role="group" aria-label="Duration">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={preset === p.key ? "fpill on" : "fpill"} aria-pressed={preset === p.key} onClick={() => setPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" ? (
          <div className="rq-range">
            <label><span className="cell-sub">From (optional)</span><input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label><span className="cell-sub">Until (optional)</span><input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
          </div>
        ) : (
          <p className="rq-hint">From now, for {PRESETS.find((p) => p.key === preset)?.label}.</p>
        )}
      </div>

      <div className="rq-sec">
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

      {needsTicket && (
        <div className="rq-sec">
          <div className="rq-label"><span>Ticket</span><span className="mono t-muted">{ticketing?.checked ? `checked in ${ticketing.system}` : "required"}</span></div>
          <input className="input mono" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder={ticketing?.kind === "jira" ? "OPS-123" : "CHG0030001"} aria-label="Ticket number" spellCheck={false} autoComplete="off" />
          <p className="rq-hint">
            {ticketMode === "itsm"
              ? "The change or incident you work under. If it is approved there, access opens at once; otherwise an approver decides. Access lasts while the ticket is open, within its change window."
              : ticketing?.checked
                ? "The change or incident you work under. Access lasts while the ticket is open, within its change window."
                : "The change or incident you work under; approvers see it."}
          </p>
        </div>
      )}

      <div className="rq-sec">
        <div className="rq-label">
          <span>Justification{requireJustification ? "" : " (optional)"}</span>
          {requireJustification && <span className={why.trim().length >= MIN_JUSTIFICATION ? "mono t-ok" : "mono t-muted"}>{why.trim().length} / {MIN_JUSTIFICATION}+</span>}
        </div>
        <textarea className="textarea" rows={3} placeholder="What will you do, and why now?" value={why} onChange={(e) => setWhy(e.target.value)} />
      </div>

      <div className="rq-approver">
        <span className="rq-approver-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
        </span>
        <span><b>Approvers</b> · {ticketMode === "itsm" ? `an approval in ${ticketing?.system ?? "the ticket system"} is enough; otherwise the administrators of this workspace decide.` : "the administrators of this workspace decide, as its policy sets."}</span>
      </div>

      <div className="rq-foot">
        <span className={missing.length ? "rq-status t-muted" : "rq-status t-ok"}>
          {missing.length ? `Missing: ${missing.join(", ")}` : "Ready to send."}
        </span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || missing.length > 0}>{busy ? "Sending…" : "Send request"}</button>
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
