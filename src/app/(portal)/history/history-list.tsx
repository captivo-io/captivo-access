"use client";
import { useState } from "react";
import type { HistoryRowJSON } from "@/lib/portal/history";
import { LocalTime } from "@/app/(app)/_shell/local-time";

export function HistoryList({ initial, pageSize }: { initial: HistoryRowJSON[]; pageSize: number }) {
  const [rows, setRows] = useState<HistoryRowJSON[]>(initial);
  const [done, setDone] = useState(initial.length < pageSize);
  const [busy, setBusy] = useState(false);

  async function loadMore() {
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/history?offset=${rows.length}`);
      const data = (await res.json()) as { rows: HistoryRowJSON[] };
      setRows((r) => [...r, ...data.rows]);
      if (data.rows.length < pageSize) setDone(true);
    } catch {
      /* ignore */
    }
    setBusy(false);
  }

  if (rows.length === 0) return <div className="empty">No sessions yet.</div>;
  return (
    <div className="card">
      {rows.map((r) => (
        <div key={r.id} className="hist-row">
          <span className="hist-name">{r.name}{r.protocol ? ` · ${r.protocol.toUpperCase()}` : ""}</span>
          <span className="mono t-muted hist-meta"><LocalTime iso={r.date} mode="shortdate" /> · {r.durationText}</span>
        </div>
      ))}
      {!done && (
        <button type="button" className="btn sm hist-more" disabled={busy} onClick={loadMore}>
          {busy ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
