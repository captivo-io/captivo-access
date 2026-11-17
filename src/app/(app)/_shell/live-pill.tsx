"use client";
import Link from "next/link";
import { livePillView } from "@/lib/nav/live-pill";
import { useLiveCount } from "./live-count";

/** "● 1 live" in the header while sessions are running; nothing when none are. */
export function LivePill() {
  const view = livePillView(useLiveCount(true));
  if (!view.live) return null;
  return (
    <Link href="/admin/live" className="live-pill on" aria-label={`Live sessions: ${view.label}`} title="Live sessions">
      <span className="live-dot" aria-hidden="true" />
      {view.label}
    </Link>
  );
}
