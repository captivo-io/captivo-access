"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModerationKind, ModerationStatus } from "./rules";

export interface ModerationRequestState {
  status: ModerationStatus | "asking" | "error";
  expiresAt: string | null;
  /** Ask again after a decline or when the wait ran out. */
  retry: () => void;
  cancel: () => void;
}

/**
 * The user's side of a moderated session: asks for a moderator once, then
 * follows the request every 2 s until a moderator admits or declines it, or
 * it runs out. Leaving the page withdraws a request still waiting.
 */
export function useModerationRequest(siteId: string, kind: ModerationKind, enabled = true): ModerationRequestState {
  const [status, setStatus] = useState<ModerationRequestState["status"]>("asking");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const idRef = useRef<string | null>(null);
  const base = `/api/gateway/${encodeURIComponent(siteId)}/moderation`;

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const follow = async () => {
      if (stop || !idRef.current) return;
      const r = await fetch(`${base}?id=${encodeURIComponent(idRef.current)}`, { cache: "no-store" }).catch(() => null);
      if (stop) return;
      const j = r?.ok ? ((await r.json().catch(() => null)) as { status?: ModerationStatus } | null) : null;
      if (j?.status) setStatus(j.status);
      if (!j?.status || j.status === "waiting") timer = setTimeout(follow, 2000);
    };
    void (async () => {
      const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as { id?: string; status?: ModerationStatus; expiresAt?: string } | null) : null;
      if (stop) return;
      if (!j?.id || !j.status) { setStatus("error"); return; }
      idRef.current = j.id;
      setExpiresAt(j.expiresAt ?? null);
      setStatus(j.status);
      if (j.status === "waiting") timer = setTimeout(follow, 2000);
    })();
    const withdraw = () => {
      if (idRef.current) navigator.sendBeacon?.(`${base}/cancel?id=${encodeURIComponent(idRef.current)}`);
    };
    window.addEventListener("pagehide", withdraw);
    return () => { stop = true; if (timer) clearTimeout(timer); window.removeEventListener("pagehide", withdraw); };
  }, [base, kind, enabled, round]);

  const retry = useCallback(() => { idRef.current = null; setStatus("asking"); setRound((n) => n + 1); }, []);
  const cancel = useCallback(() => {
    const id = idRef.current;
    idRef.current = null;
    if (id) void fetch(`${base}?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    setStatus("cancelled");
  }, [base]);
  return { status, expiresAt, retry, cancel };
}
