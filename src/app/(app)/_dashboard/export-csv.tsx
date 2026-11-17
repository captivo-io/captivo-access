"use client";
import type { Insights } from "@/lib/dashboard/insights";

/** The period's daily access, resources and vendors as one CSV file. */
export function ExportCsvButton({ insights, range }: { insights: Insights; range: number }) {
  function download() {
    const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines: string[] = ["section,key,label,value"];
    for (const d of insights.trend) {
      lines.push(["daily_accessed", d.date, "", d.allow].map(q).join(","));
      lines.push(["daily_blocked", d.date, "", d.deny].map(q).join(","));
    }
    for (const r of insights.topResources) lines.push(["top_resource", r.id, r.label, r.count].map(q).join(","));
    for (const v of insights.topVendors) lines.push(["top_vendor", v.id, v.label, v.count].map(q).join(","));
    for (const r of insights.deny.reasons) lines.push(["deny_reason", "", r.label, r.count].map(q).join(","));
    lines.push(["access_type", "web", "", insights.typeMix.web].map(q).join(","));
    lines.push(["access_type", "remote", "", insights.typeMix.remote].map(q).join(","));
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `captivo-access-insights-${range}d-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return <button type="button" className="btn" onClick={download}>Export CSV</button>;
}
