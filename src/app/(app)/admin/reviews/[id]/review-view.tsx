"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { OUTCOME_LABEL, RECURRENCE_LABEL, STALE_DAYS, type Decision, type Outcome, type Recurrence } from "@/lib/review/plan";

export type ReviewItemVM = {
  id: string; userId: string; userLabel: string; userEmail: string | null; userRole: string | null; siteName: string;
  grantCreatedAt: string; grantedBy: string | null; grantEndsAt: string | null; scheduled: boolean; directoryManaged: boolean;
  lastUsedAt: string | null; decision: string | null; limitTo: string | null; decidedByLabel: string | null; decidedAt: string | null; outcome: string | null;
};
type ReviewVM = { id: string; name: string; status: string; dueAt: string | null; openedAt: string | null; opensAt: string; closedAt: string | null; onNoAnswer: string; recurrence: string | null; scope: string };
type Filter = "all" | "todo" | "stale" | "directory" | "decided";

const DECISION: Record<string, { label: string; tone: string }> = {
  keep: { label: "Keep", tone: "ok" }, revoke: { label: "Revoke", tone: "danger" }, limit: { label: "Limit", tone: "warn" }, ad_remove: { label: "Remove from group", tone: "warn" },
};
const OUTCOME_TONE: Record<string, string> = { kept: "ok", limited: "warn", revoked: "danger", auto_revoked: "danger", unanswered: "neutral", ad_remove: "warn", gone: "neutral" };
const SKIP: Record<string, string> = { own_access: "your own access", directory_managed: "from a directory group", not_directory: "not from a directory group" };

function daysAgo(iso: string | null, from: number): number | null {
  return iso ? Math.floor((from - Date.parse(iso)) / 86_400_000) : null;
}

function isStale(i: ReviewItemVM, from: number): boolean {
  const d = daysAgo(i.lastUsedAt, from);
  return d === null || d > STALE_DAYS;
}

/**
 * One access review: every grant it lists, when each was last used, and the
 * decision on it. Open, reviewers mark grants (one at a time or many at once)
 * and the decisions apply when it closes; closed, it is the report.
 */
export function ReviewView({ review, items, me, canReview }: { review: ReviewVM; items: ReviewItemVM[]; me: string; canReview: boolean }) {
  const router = useRouter();
  const open = review.status === "open";
  const editable = open && canReview;
  const ref = Date.parse(review.openedAt ?? review.opensAt);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [limitTo, setLimitTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [confirm, setConfirm] = useState<"close" | "cancel" | null>(null);

  const stale = (i: ReviewItemVM) => isStale(i, ref);
  const counts = {
    all: items.length,
    todo: items.filter((i) => !i.decision).length,
    stale: items.filter((i) => isStale(i, ref)).length,
    directory: items.filter((i) => i.directoryManaged).length,
    decided: items.filter((i) => i.decision).length,
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => {
    if (filter === "todo" && i.decision) return false;
    if (filter === "stale" && !stale(i)) return false;
    if (filter === "directory" && !i.directoryManaged) return false;
    if (filter === "decided" && !i.decision) return false;
    return !needle || `${i.userLabel} ${i.userEmail ?? ""} ${i.siteName}`.toLowerCase().includes(needle);
  });
  const selectable = shown.filter((i) => i.userId !== me);
  const allSel = selectable.length > 0 && selectable.every((i) => sel.has(i.id));

  async function decide(ids: string[], decision: Decision | null, until?: string) {
    setBusy("decide");
    try {
      const res = await fetch(`/api/admin/reviews/${review.id}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIds: ids, decision, ...(until ? { limitTo: new Date(until + "T23:59:59").toISOString() } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setToast({ msg: j.error === "limit_in_past" ? "Pick a date in the future." : "Couldn't save the decision. Try again.", ok: false }); return; }
      const skipped = (j.skipped ?? []) as { why: string }[];
      setToast(skipped.length
        ? { msg: `${j.done} saved; ${skipped.length} skipped (${[...new Set(skipped.map((s) => SKIP[s.why] ?? s.why))].join(", ")})`, ok: j.done > 0 }
        : { msg: decision ? `${j.done} marked “${DECISION[decision].label}”` : `${j.done} cleared`, ok: true });
      setSel(new Set());
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  async function finish(kind: "close" | "cancel") {
    if (confirm !== kind) { setConfirm(kind); return; }
    setBusy(kind);
    try {
      const res = await fetch(kind === "close" ? `/api/admin/reviews/${review.id}/close` : `/api/admin/reviews/${review.id}`, { method: kind === "close" ? "POST" : "DELETE" });
      setToast(res.ok ? { msg: kind === "close" ? "Review closed and applied" : "Review cancelled; nothing changed", ok: true } : { msg: "That didn't work. Reload and try again.", ok: false });
      setConfirm(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const due = review.dueAt ? Date.parse(review.dueAt) : null;
  const left = due ? Math.ceil((due - Date.now()) / 86_400_000) : null;
  const decidedPct = items.length ? Math.round((counts.decided / items.length) * 100) : 100;
  const outcomes = review.status === "closed" ? items.reduce<Record<string, number>>((a, i) => { if (i.outcome) a[i.outcome] = (a[i.outcome] ?? 0) + 1; return a; }, {}) : {};
  const adList = items.filter((i) => i.outcome === "ad_remove" || (open && i.decision === "ad_remove"));

  return (
    <div className="arv">
      <Link href="/admin/reviews" className="btn sm rc-back">← Access reviews</Link>
      <div className="page-head">
        <div>
          <div className="eyebrow">Access review · {review.scope}{review.recurrence ? ` · ${RECURRENCE_LABEL[review.recurrence as Recurrence]}` : ""}</div>
          <h1>{review.name}</h1>
          <p>
            {open ? <>Due <LocalTime iso={review.dueAt!} />{left !== null && left >= 0 ? ` · ${left} day${left === 1 ? "" : "s"} left` : ""}. Decisions apply when it closes; until then any of them can change. {review.onNoAnswer === "revoke" ? "Grants without a decision are removed at the due date, except directory grants and reviewers' own." : "Grants without a decision are kept and listed as not reviewed."}</>
              : review.status === "closed" ? <>Closed <LocalTime iso={review.closedAt!} />. This is its report.</>
              : review.status === "scheduled" ? <>Opens <LocalTime iso={review.opensAt} />.</>
              : <>Cancelled. No access was changed.</>}
          </p>
        </div>
        <div className="row-actions">
          <a className="btn" href={`/api/admin/reviews/${review.id}/export`}>Export CSV</a>
          {review.status === "closed" && <button type="button" className="btn" onClick={() => window.print()}>Print</button>}
          {editable && (
            <>
              <button type="button" className={confirm === "cancel" ? "btn danger on" : "btn"} disabled={!!busy} onClick={() => void finish("cancel")}>{confirm === "cancel" ? "Sure? Cancel review" : "Cancel review"}</button>
              <button type="button" className={confirm === "close" ? "btn primary on" : "btn primary"} disabled={!!busy} onClick={() => void finish("close")}>{busy === "close" ? "Closing…" : confirm === "close" ? `Apply now: ${counts.todo} without decision ${review.onNoAnswer === "revoke" ? "are removed" : "are kept"}` : "Close and apply"}</button>
            </>
          )}
        </div>
      </div>

      {review.status === "closed" ? (
        <div className="kstrip">
          {(["kept", "limited", "revoked", "auto_revoked", "ad_remove", "unanswered", "gone"] as Outcome[]).filter((o) => outcomes[o] || o === "kept" || o === "revoked").map((o) => (
            <div key={o} className="kcell"><span className="kcell-k"><span className={`rs-kdot ${OUTCOME_TONE[o] === "danger" ? "bad" : OUTCOME_TONE[o] === "neutral" ? "p" : OUTCOME_TONE[o]}`} />{OUTCOME_LABEL[o]}</span><span className="kcell-row"><span className="kcell-v">{outcomes[o] ?? 0}</span></span></div>
          ))}
        </div>
      ) : (
        <div className="kstrip">
          <div className="kcell"><span className="kcell-k"><span className="rs-kdot p" />Progress</span><span className="kcell-row"><span className="kcell-v">{decidedPct}%</span><span className="kcell-s">{counts.decided} of {items.length} decided</span></span><span className="arv-bar wide"><span style={{ width: `${decidedPct}%` }} /></span></div>
          <button type="button" className={`kcell rs-cell warn${filter === "stale" ? " on" : ""}`} onClick={() => setFilter(filter === "stale" ? "all" : "stale")}><span className="kcell-k"><span className="rs-kdot warn" />Unused {STALE_DAYS}+ days</span><span className="kcell-row"><span className="kcell-v">{counts.stale}</span><span className="kcell-s">or never used</span></span></button>
          <button type="button" className={`kcell rs-cell${filter === "directory" ? " on" : ""}`} onClick={() => setFilter(filter === "directory" ? "all" : "directory")}><span className="kcell-k"><span className="rs-kdot violet" />From directory groups</span><span className="kcell-row"><span className="kcell-v">{counts.directory}</span><span className="kcell-s">removed in AD, not here</span></span></button>
        </div>
      )}

      <div className="ma-tools arv-tools">
        <label className="ma-search">
          <NavIcon name="search" size={16} />
          <input type="search" placeholder="Person or resource…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </label>
        <div className="seg" role="group" aria-label="Show">
          {(open ? ([["all", "All"], ["todo", "To decide"], ["stale", "Unused"], ["directory", "Directory"], ["decided", "Decided"]] as const) : ([["all", "All"], ["stale", "Unused"], ["directory", "Directory"]] as const)).map(([k, l]) => (
            <button key={k} type="button" className={filter === k ? "seg-opt on" : "seg-opt"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} <span className="rs-n">{counts[k]}</span></button>
          ))}
        </div>
      </div>

      {editable && sel.size > 0 && (
        <div className="arv-bulk" role="toolbar" aria-label="Decide on the selected grants">
          <b>{sel.size} selected</b>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void decide([...sel], "keep")}>Keep</button>
          <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => void decide([...sel], "revoke")}>Revoke</button>
          <span className="arv-limit">
            <input id="arv-limit" type="date" className="input sm" value={limitTo} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setLimitTo(e.target.value)} aria-label="Limit until" />
            <button type="button" className="btn sm" disabled={!!busy || !limitTo} onClick={() => void decide([...sel], "limit", limitTo)}>Limit until</button>
          </span>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void decide([...sel], null)}>Clear</button>
          <button type="button" className="btn sm ghost" onClick={() => setSel(new Set())}>Deselect</button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="au-empty"><b>No grants in scope</b><span className="cell-sub">Nobody had live access to these resources when the review opened.</span></div>
      ) : (
        <div className="table-wrap">
          <table className="table arv-table">
            <thead>
              <tr>
                {editable && <th className="arv-ck"><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(selectable.map((i) => i.id)))} aria-label="Select all shown" /></th>}
                <th>Person</th><th>Resource</th><th>Granted</th><th>Last used</th><th>{review.status === "closed" ? "Outcome" : "Decision"}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const own = i.userId === me;
                const d = daysAgo(i.lastUsedAt, ref);
                const old = d === null || d > STALE_DAYS;
                return (
                  <tr key={i.id} className={sel.has(i.id) ? "on" : undefined}>
                    {editable && <td className="arv-ck">{!own && <input type="checkbox" checked={sel.has(i.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} aria-label={`Select ${i.userLabel} on ${i.siteName}`} />}</td>}
                    <td><b>{i.userLabel}</b><div className="cell-sub mono">{i.userEmail}{i.userRole ? ` · ${i.userRole.toLowerCase()}` : ""}</div></td>
                    <td><b>{i.siteName}</b>{i.directoryManaged && <div><span className="chip violet arv-dir">DIRECTORY GROUP</span></div>}</td>
                    <td className="cell-sub"><LocalTime iso={i.grantCreatedAt} mode="date" />{i.grantedBy ? ` · ${i.grantedBy}` : ""}<div>{i.grantEndsAt ? <>until <LocalTime iso={i.grantEndsAt} mode="date" /></> : "no end date"}{i.scheduled ? " · set hours" : ""}</div></td>
                    <td className={old ? "arv-stale" : "cell-sub"}>{i.lastUsedAt ? <><LocalTime iso={i.lastUsedAt} mode="date" /><div className="cell-sub">{d} day{d === 1 ? "" : "s"} before</div></> : <b>Never</b>}</td>
                    <td>
                      {review.status === "closed" ? (
                        <><span className={`pill ${OUTCOME_TONE[i.outcome ?? "unanswered"]}`}>{OUTCOME_LABEL[(i.outcome ?? "unanswered") as Outcome]}</span>{i.decidedByLabel && <div className="cell-sub">{i.decidedByLabel}</div>}</>
                      ) : own ? (
                        <span className="cell-sub">Your own access: another reviewer decides.</span>
                      ) : editable ? (
                        <div className="arv-dec">
                          <button type="button" className={i.decision === "keep" ? "rf-pill on ok" : "rf-pill"} disabled={!!busy} onClick={() => void decide([i.id], i.decision === "keep" ? null : "keep")}>Keep</button>
                          {i.directoryManaged
                            ? <button type="button" className={i.decision === "ad_remove" ? "rf-pill on warn" : "rf-pill"} disabled={!!busy} onClick={() => void decide([i.id], i.decision === "ad_remove" ? null : "ad_remove")}>Remove from group</button>
                            : <button type="button" className={i.decision === "revoke" ? "rf-pill on bad" : "rf-pill"} disabled={!!busy} onClick={() => void decide([i.id], i.decision === "revoke" ? null : "revoke")}>Revoke</button>}
                          {i.decision === "limit" && <span className="pill warn">until <LocalTime iso={i.limitTo!} mode="date" /></span>}
                          {i.decidedByLabel && <div className="cell-sub arv-who">{i.decidedByLabel}</div>}
                        </div>
                      ) : i.decision ? (
                        <span className={`pill ${DECISION[i.decision].tone}`}>{DECISION[i.decision].label}</span>
                      ) : <span className="cell-sub">No decision yet</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adList.length > 0 && (
        <section className="arv-ad">
          <h2>Remove in the directory</h2>
          <p className="cell-sub">These grants come from directory groups: Captivo gives them back at the next sign-in while the person is in the group. Remove the person from the group in Active Directory.</p>
          <ul>{adList.map((i) => <li key={i.id}><b>{i.userLabel}</b> <span className="mono cell-sub">{i.userEmail}</span> → {i.siteName}</li>)}</ul>
        </section>
      )}

      {toast && <div className={toast.ok ? "toast" : "toast warn"} role="status"><span aria-hidden="true">{toast.ok ? "✓" : "!"}</span> {toast.msg}</div>}
    </div>
  );
}
