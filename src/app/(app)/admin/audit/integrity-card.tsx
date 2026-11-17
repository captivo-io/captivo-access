"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import { ago } from "../connectors/connectors-view";

export interface ChainInfo {
  scope: "access" | "admin";
  count: number;
  firstSeq: string | null;
  lastSeq: string | null;
  verifiedAt: string | null;
  verifiedOk: boolean | null;
}

export interface AnchorInfo {
  enabled: boolean;
  count: number;
  last: { anchoredSeq: string; genTime: string; tsaUrl: string } | null;
}

type Verdict = { ok: boolean; count: number; brokenAtSeq: string | null; reason: string | null };
type AnchorVerdict = { id: string; anchoredSeq: string; genTime: string | null; ok: boolean; beyondRetention: boolean; reason: string | null };

const BLOCKS = 28;
const STEP_MS = 70;

/**
 * The tamper-evident chain (design hand-off 7.9): one row with the state, the
 * strip of blocks and "Verify again". The check is one request; the blocks fill
 * while it runs and settle on its answer (the server does not stream progress).
 */
export function IntegrityCard({ chain, anchor }: { chain: ChainInfo; anchor: AnchorInfo }) {
  const admin = chain.scope === "admin";
  const [state, setState] = useState<"idle" | "verifying">("idle");
  const [ok, setOk] = useState<boolean | null>(chain.verifiedOk);
  const [at, setAt] = useState<string | null>(chain.verifiedAt);
  const [broken, setBroken] = useState<string | null>(null);
  const [filled, setFilled] = useState(chain.verifiedOk === null ? 0 : BLOCKS);
  const [toast, setToast] = useState<string | null>(null);
  // Set after mount, so the server render and the first client render agree.
  const [now, setNow] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(t); if (timer.current) clearInterval(timer.current); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  async function verify() {
    setState("verifying");
    setBroken(null);
    setFilled(0);
    timer.current = setInterval(() => setFilled((f) => Math.min(BLOCKS - 1, f + 1)), STEP_MS);
    const started = Date.now();
    let v: Verdict;
    try {
      const res = await fetch(admin ? "/api/admin/audit/admin-verify" : "/api/admin/audit/verify");
      v = res.ok ? ((await res.json()) as Verdict) : { ok: false, count: 0, brokenAtSeq: null, reason: "request_failed" };
    } catch {
      v = { ok: false, count: 0, brokenAtSeq: null, reason: "request_failed" };
    }
    // Let the strip run its course once, so a quick answer still reads as a check.
    await new Promise((r) => setTimeout(r, Math.max(0, BLOCKS * STEP_MS - (Date.now() - started))));
    if (timer.current) clearInterval(timer.current);
    setState("idle");
    if (v.reason === "request_failed") {
      setFilled(ok === null ? 0 : BLOCKS);
      setToast("The check could not run. Try again.");
      return;
    }
    setOk(v.ok);
    setAt(new Date().toISOString());
    setNow(Date.now());
    setBroken(v.ok ? null : v.brokenAtSeq);
    setFilled(BLOCKS);
    setToast(v.ok ? `Chain verified · ${v.count.toLocaleString("en-US")} ${admin ? "records" : "events"}` : "The chain is broken");
  }

  // Where a break sits along the strip.
  const first = Number(chain.firstSeq ?? 1), last = Number(chain.lastSeq ?? 1);
  const badAt = ok === false
    ? (broken && last > first ? Math.min(BLOCKS - 1, Math.floor(((Number(broken) - first) / (last - first)) * BLOCKS)) : BLOCKS - 1)
    : -1;
  const verifying = state === "verifying";
  const tone = verifying ? "busy" : ok === false ? "bad" : ok ? "ok" : "none";
  const title = verifying ? "Verifying chain…"
    : ok === false ? (broken ? `Chain broken · seq #${broken}` : "Chain broken at the last check")
    : ok ? "Record chain intact"
    : "Chain not verified yet";
  const noun = admin ? "records" : "events";
  const meta = [
    `${chain.count.toLocaleString("en-US")} ${noun}`,
    chain.firstSeq && chain.lastSeq ? `seq ${chain.firstSeq}–${chain.lastSeq}` : null,
    "SHA-256 chain",
    `last verified: ${at ? (now === null ? "…" : ago(now - Date.parse(at))) : "never"}`,
  ].filter(Boolean).join(" · ");

  return (
    <section className={`au-int ${tone}`} aria-live="polite">
      <div className="au-int-row">
        <span className="au-int-ic"><NavIcon name="shield" size={19} /></span>
        <div className="au-int-t">
          <b>{title}</b>
          <span className="mono">{meta}</span>
        </div>
        <div className="au-chainstrip" aria-hidden="true">
          {Array.from({ length: BLOCKS }, (_, i) => {
            const cls = i === badAt && !verifying ? "bad" : i < filled ? "ok" : verifying && i === filled ? "cur" : "";
            return (
              <Fragment key={i}>
                {i > 0 && <i className={i < filled ? "ok" : undefined} />}
                <span className={cls} />
              </Fragment>
            );
          })}
        </div>
        <button type="button" className="btn sm" onClick={verify} disabled={verifying}>
          {verifying ? <><span className="au-spin" aria-hidden="true" /> Verifying</> : ok === null ? "Verify now" : "Verify again"}
        </button>
      </div>
      {anchor.enabled && <AnchorRow anchor={anchor} admin={admin} />}
      {toast && <div className={ok === false ? "toast warn" : "toast"} role="status"><span aria-hidden="true">{ok === false ? "!" : "✓"}</span> {toast}</div>}
    </section>
  );
}

function AnchorRow({ anchor, admin }: { anchor: AnchorInfo; admin: boolean }) {
  const [busy, setBusy] = useState(false);
  const [verdicts, setVerdicts] = useState<AnchorVerdict[] | null>(null);
  const base = admin ? "/api/admin/audit/admin-anchors" : "/api/admin/audit/anchors";

  async function verify() {
    setBusy(true);
    setVerdicts(null);
    try {
      const res = await fetch(`${base}/verify`, { method: "POST" });
      setVerdicts(res.ok ? ((await res.json()) as { verdicts: AnchorVerdict[] }).verdicts : []);
    } catch {
      setVerdicts([]);
    }
    setBusy(false);
  }

  return (
    <div className="au-int-sub">
      <div className="au-int-row">
        <div className="au-int-t">
          <b>External anchor</b>
          <span className="cell-sub">
            {anchor.last
              ? <>Last: seq {anchor.last.anchoredSeq} · <LocalTime iso={anchor.last.genTime} mode="short" /> · {anchor.count} anchor{anchor.count === 1 ? "" : "s"} · {anchor.last.tsaUrl}</>
              : "Enabled, but no anchor recorded yet (runs daily)."}
          </span>
        </div>
        {anchor.count > 0 && <button type="button" className="btn sm" onClick={verify} disabled={busy}>{busy ? "Verifying…" : "Verify anchors"}</button>}
      </div>
      {verdicts && (
        verdicts.length === 0 ? <p className="cell-sub">Anchor verification failed.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Seq</th><th>Timestamp</th><th>Status</th><th /></tr></thead>
              <tbody>
                {verdicts.map((v) => (
                  <tr key={v.id}>
                    <td>{v.anchoredSeq}</td>
                    <td className="cell-sub">{v.genTime ? <LocalTime iso={v.genTime} /> : "—"}</td>
                    <td>{v.ok ? <span className="rs-pill up">{v.beyondRetention ? "Verified (beyond retention)" : "Verified"}</span> : <span className="rs-pill down">Failed: {v.reason}</span>}</td>
                    <td><a className="btn sm" href={`${base}/${v.id}/token`}>Download .tsr</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
