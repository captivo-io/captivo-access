"use client";
import { useState } from "react";
import type { Insights } from "@/lib/dashboard/insights";
import { heatmapInZone } from "@/lib/dashboard/heatmap-zone";
import { useEffectiveTimezone } from "@/app/(app)/_shell/effective-timezone";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Hover = { dow: number; hour: number; v: number; x: number; y: number };

export function Heatmap({ heatmap }: { heatmap: Insights["heatmap"] }) {
  const [hov, setHov] = useState<Hover | null>(null);
  const tz = useEffectiveTimezone();
  // Counted in UTC; shown in the viewer's zone when it is a whole-hour offset.
  const local = heatmapInZone(heatmap.grid, tz, new Date());
  const grid = local ?? heatmap.grid;
  const zone = local ? tz! : "UTC";
  const max = Math.max(1, heatmap.max);
  return (
    <>
      <div className="card-head"><div className="ch-title"><h2>Traffic by hour</h2><span className="sub">day × hour ({zone}), last 30 days</span></div></div>
      <div className="heatmap-wrap" onMouseLeave={() => setHov(null)}>
        <div className="heatmap">
          {grid.map((rowVals, dow) => (
            <div key={dow} className="heatmap-row">
              <span className="heatmap-day">{DAYS[dow]}</span>
              {rowVals.map((v, h) => (
                <span
                  key={h}
                  className={`heatmap-cell${hov && hov.dow === dow && hov.hour === h ? " hot" : ""}`}
                  style={{ opacity: v === 0 ? 0.06 : 0.18 + 0.82 * (v / max) }}
                  onMouseEnter={(e) => {
                    const wrap = e.currentTarget.closest(".heatmap-wrap") as HTMLElement;
                    const r = wrap.getBoundingClientRect();
                    const c = e.currentTarget.getBoundingClientRect();
                    setHov({ dow, hour: h, v, x: c.left - r.left + c.width / 2, y: c.top - r.top });
                  }}
                />
              ))}
            </div>
          ))}
          <div className="heatmap-axis"><span className="heatmap-day" />{[0, 6, 12, 18].map((h) => <span key={h}>{h}:00</span>)}</div>
        </div>
        {hov && (
          <div className="heat-tip" style={{ left: hov.x, top: hov.y }}>
            {DAYS[hov.dow]} {String(hov.hour).padStart(2, "0")}:00 {zone} — {hov.v} access{hov.v === 1 ? "" : "es"}
          </div>
        )}
      </div>
    </>
  );
}
