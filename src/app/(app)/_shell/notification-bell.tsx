"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Item = { id: string; type: string; siteName: string; detail: string | null; when: string };
type Req = { id: string; who: string; siteName: string; when: string };

const TITLE: Record<string, string> = { site_down: "Resource down", site_recovered: "Resource recovered", rotation_failed: "Password rotation failed", out_of_sync: "Password changed outside Captivo", review_open: "Access review open", review_due: "Access review due", review_closed: "Access review closed", ticket_ended: "Ticket closed access", ticket_approved: "Ticket approved access", credential_checkout: "Password checked out", checkout_not_rotated: "Checked-out password not changed" };

export function NotificationBell({ badge, open, onToggle }: { badge: number; open: boolean; onToggle: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [requests, setRequests] = useState<Req[]>([]);
  const [requestCount, setRequestCount] = useState(0);
  const [moderation, setModeration] = useState<Req[]>([]);
  const [unread, setUnread] = useState(badge);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { items: Item[]; unread: number; requests?: Req[]; requestCount?: number; moderation?: Req[] };
      setItems(body.items);
      setModeration(body.moderation ?? []);
      setRequests(body.requests ?? []);
      setRequestCount(body.requestCount ?? 0);
      setUnread(body.unread);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Any mutation: refresh the panel list AND the server-rendered badge.
  async function act(url: string, method: "POST" | "DELETE") {
    await fetch(url, { method }).catch(() => {});
    await load();
    router.refresh();
  }

  return (
    <div className="tn-menuwrap tn-notif">
      <button className="icon-btn tn-icon" aria-haspopup="menu" aria-expanded={open} aria-label="Notifications" onClick={onToggle}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        {badge > 0 && <span className="tn-badge tn-badge-dot">{badge}</span>}
      </button>
      {open && (
        <div className="tn-notif-panel" role="menu">
          <div className="tn-notif-head">
            <span>Notifications</span>
            {items.length > 0 && (
              <button className="tn-notif-link" onClick={() => void act("/api/admin/notifications/read", "POST")}>Mark all read</button>
            )}
          </div>
          {moderation.length > 0 && (
            <div className="tn-notif-list tn-notif-reqs">
              {moderation.map((r) => (
                <Link key={r.id} href="/admin/live" className="tn-notif-item tn-notif-req" onClick={onToggle}>
                  <div className="tn-notif-body">
                    <div className="tn-notif-title"><span className="req">Moderator needed</span> — {r.who} on {r.siteName}</div>
                    <div className="tn-notif-when">{r.when} · the session starts when a moderator joins</div>
                  </div>
                  <span className="tn-notif-go" aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          )}
          {requests.length > 0 && (
            <div className="tn-notif-list tn-notif-reqs">
              {requests.map((r) => (
                <Link key={r.id} href="/admin/grants" className="tn-notif-item tn-notif-req" onClick={onToggle}>
                  <div className="tn-notif-body">
                    <div className="tn-notif-title"><span className="req">Access request</span> — {r.who} asks for {r.siteName}</div>
                    <div className="tn-notif-when">{r.when} · waiting for a decision</div>
                  </div>
                  <span className="tn-notif-go" aria-hidden="true">→</span>
                </Link>
              ))}
              {requestCount > requests.length && (
                <Link href="/admin/grants" className="tn-notif-link tn-notif-reqmore" onClick={onToggle}>and {requestCount - requests.length} more requests →</Link>
              )}
            </div>
          )}
          <div className="tn-notif-list">
            {loading && items.length === 0 && requests.length === 0 && moderation.length === 0 ? (
              <div className="tn-notif-empty">Loading…</div>
            ) : items.length === 0 ? (
              requests.length === 0 && moderation.length === 0 && <div className="tn-notif-empty">You&apos;re all caught up.</div>
            ) : (
              items.map((n) => (
                <div key={n.id} className="tn-notif-item">
                  <div className="tn-notif-body">
                    <div className="tn-notif-title">
                      <span className={n.type === "site_down" || n.type === "rotation_failed" || n.type === "out_of_sync" || n.type === "ticket_ended" || n.type === "checkout_not_rotated" ? "down" : n.type === "site_recovered" ? "up" : undefined}>{TITLE[n.type] ?? n.type}</span> — {n.siteName}
                    </div>
                    {n.detail && <div className="tn-notif-detail">{n.detail}</div>}
                    <div className="tn-notif-when">{n.when}</div>
                  </div>
                  <div className="tn-notif-actions">
                    <button title="Mark read" aria-label="Mark read" onClick={() => void act(`/api/admin/notifications/${n.id}/read`, "POST")}>✓</button>
                    <button title="Delete" aria-label="Delete" onClick={() => void act(`/api/admin/notifications/${n.id}`, "DELETE")}>✕</button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="tn-notif-foot">
            <Link href="/admin/notifications" className="tn-notif-link" onClick={onToggle}>View all notifications →</Link>
            {unread > items.length && <span className="tn-notif-more">and {unread - items.length} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
