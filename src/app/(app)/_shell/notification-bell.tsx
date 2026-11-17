"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Item = { id: string; type: string; siteName: string; detail: string | null; when: string };

const TITLE: Record<string, string> = { site_down: "Resource down", site_recovered: "Resource recovered" };

export function NotificationBell({ badge, open, onToggle }: { badge: number; open: boolean; onToggle: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(badge);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { items: Item[]; unread: number };
      setItems(body.items);
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
          <div className="tn-notif-list">
            {loading && items.length === 0 ? (
              <div className="tn-notif-empty">Loading…</div>
            ) : items.length === 0 ? (
              <div className="tn-notif-empty">You&apos;re all caught up.</div>
            ) : (
              items.map((n) => (
                <div key={n.id} className="tn-notif-item">
                  <div className="tn-notif-body">
                    <div className="tn-notif-title">
                      <span className={n.type === "site_down" ? "down" : n.type === "site_recovered" ? "up" : undefined}>{TITLE[n.type] ?? n.type}</span> — {n.siteName}
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
