"use client";

import { useState } from "react";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";

type Result = {
  ok: boolean;
  count: number;
  firstSeq: string | null;
  lastSeq: string | null;
  retentionBoundary: boolean;
  brokenAtSeq: string | null;
  reason: string | null;
};

type AnchorProp = {
  enabled: boolean;
  count: number;
  last: { anchoredSeq: string; genTime: string; tsaUrl: string } | null;
};

type AnchorVerdict = {
  id: string;
  anchoredSeq: string;
  genTime: string | null;
  ok: boolean;
  beyondRetention: boolean;
  reason: string | null;
};

export function IntegrityPanel({ anchor }: { anchor: AnchorProp }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchorVerdicts, setAnchorVerdicts] = useState<AnchorVerdict[] | null>(null);
  const [anchorBusy, setAnchorBusy] = useState(false);

  async function check() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/audit/verify");
      if (!res.ok) {
        setError("Integrity check request failed.");
        return;
      }
      setResult((await res.json()) as Result);
    } catch {
      setError("Integrity check request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyAnchors() {
    setAnchorBusy(true);
    setError(null);
    setAnchorVerdicts(null);
    try {
      const res = await fetch("/api/admin/audit/anchors/verify", { method: "POST" });
      if (!res.ok) {
        setError("Anchor verification failed.");
        return;
      }
      const body = (await res.json()) as { verdicts: AnchorVerdict[] };
      setAnchorVerdicts(body.verdicts);
    } catch {
      setError("Anchor verification failed.");
    } finally {
      setAnchorBusy(false);
    }
  }

  return (
    <div className="au-chain">
      <div className="au-chain-row">
        <span className="au-chain-ic"><NavIcon name="shield" size={18} /></span>
        <div className="au-chain-t">
          <b>Tamper-evident log</b>
          <span className="cell-sub">Each event is chained to the one before it by hash. A check proves nothing was edited or removed.</span>
        </div>
        {error && <span className="rs-pill down">{error}</span>}
        {result && result.ok && (
          <span className="rs-pill up" title={result.retentionBoundary ? "Earlier events were purged by retention" : undefined}>
            ✓ Intact · {result.count.toLocaleString()} events
            {result.firstSeq && result.lastSeq ? <span className="mono">#{result.firstSeq}–{result.lastSeq}</span> : null}
          </span>
        )}
        {result && !result.ok && <span className="rs-pill down">✗ Broken at #{result.brokenAtSeq} ({result.reason})</span>}
        <button className="btn sm" onClick={check} disabled={loading}>{loading ? "Checking…" : "Check integrity"}</button>
      </div>

      {anchor.enabled && (
        <div className="au-chain-sub">
          <div className="au-chain-row">
            <div>
              <b>External anchor</b>{" "}
              <span className="sub">
                {anchor.last
                  ? <>Last: seq {anchor.last.anchoredSeq} · <LocalTime iso={new Date(anchor.last.genTime).toISOString()} /> · {anchor.count} anchor(s) · {anchor.last.tsaUrl}</>
                  : "Enabled, but no anchor recorded yet (runs daily)."}
              </span>
            </div>
            {anchor.count > 0 && (
              <button className="btn sm" onClick={verifyAnchors} disabled={anchorBusy}>
                {anchorBusy ? "Verifying…" : "Verify anchors"}
              </button>
            )}
          </div>
          {anchorVerdicts && (
            <div className="table-wrap" style={{ marginTop: ".6rem" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Seq</th>
                    <th>Timestamp</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {anchorVerdicts.map((v) => (
                    <tr key={v.id}>
                      <td>{v.anchoredSeq}</td>
                      <td className="cell-sub">{v.genTime ? <LocalTime iso={new Date(v.genTime).toISOString()} /> : "—"}</td>
                      <td>
                        {v.ok ? (
                          <span className="pill ok">{v.beyondRetention ? "Verified (beyond retention)" : "Verified"}</span>
                        ) : (
                          <span className="pill danger">Failed: {v.reason}</span>
                        )}
                      </td>
                      <td>
                        <a className="btn sm ghost" href={`/api/admin/audit/anchors/${v.id}/token`}>
                          Download .tsr
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
