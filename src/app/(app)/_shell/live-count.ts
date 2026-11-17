"use client";
import { useSyncExternalStore } from "react";

const POLL_MS = 10_000;

// One poll of the live-session count for the whole page, however many places
// show it (the header pill and the sidebar's Sessions badge).
let count = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

async function refresh() {
  try {
    const res = await fetch("/api/admin/live/count", { cache: "no-store" });
    if (!res.ok) return; // keep the last known count
    const data = (await res.json()) as { count?: number };
    if (typeof data.count === "number" && data.count !== count) {
      count = data.count;
      listeners.forEach((l) => l());
    }
  } catch {
    // network error: keep the last known count
  }
}

function onVisible() {
  if (document.visibilityState === "visible") void refresh();
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) {
    void refresh();
    timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

const noop = () => () => {};

/** Live sessions right now; 0 (and no polling) when enabled is false. */
export function useLiveCount(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : noop, () => (enabled ? count : 0), () => 0);
}
