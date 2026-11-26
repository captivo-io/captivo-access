"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";
import type { SearchRecord } from "@/lib/search";
import { navLabel, type NavModel } from "@/lib/nav/model";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { CommandPalette } from "./command-palette";
import { NotificationBell } from "./notification-bell";
import { LivePill } from "./live-pill";
import { NavIcon } from "./nav-icons";
import { ACCESS_DOCS_URL } from "@/lib/docs-url";

/**
 * The sticky header: menu button (drawer below 1000px), breadcrumb, search,
 * the live pill, notifications, the help link and the theme toggle.
 */
// The drawer is open while <html data-nav-open="1">: the header's button and the
// sidebar (which closes it on navigation) both write it, so it is read from there.
function subscribeNav(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-nav-open"] });
  return () => mo.disconnect();
}
const navOpen = () => document.documentElement.dataset.navOpen === "1";

export function AppHeader({ model, records, role, workspace }: {
  model: NavModel; records: SearchRecord[]; role: Role; workspace: string;
}) {
  const pathname = usePathname();
  const [bell, setBell] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const page = navLabel(model, pathname);
  const drawer = useSyncExternalStore(subscribeNav, navOpen, () => false);
  // The notifications panel closes on navigation, an outside click or Escape.
  useEffect(() => { setBell(false); }, [pathname]);
  useEffect(() => {
    if (!bell) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setBell(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setBell(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [bell]);
  return (
    <header className="ah" ref={ref}>
      <button
        type="button"
        className="icon-btn ah-burger"
        aria-label="Menu"
        aria-expanded={drawer}
        aria-controls="app-sidebar"
        onClick={() => {
          const h = document.documentElement;
          h.dataset.navOpen = h.dataset.navOpen ? "" : "1";
        }}
      >
        <NavIcon name="menu" />
      </button>
      <nav className="ah-crumb" aria-label="Breadcrumb">
        <span>{workspace}</span>
        {page && (
          <>
            <span className="ah-sep" aria-hidden="true">/</span>
            <b>{page}</b>
          </>
        )}
      </nav>
      <div className="ah-right">
        {model.showSearch && <CommandPalette records={records} role={role} />}
        {model.showSearch && <LivePill />}
        {model.showNotifications && (
          <NotificationBell badge={model.notificationsBadge} open={bell} onToggle={() => setBell((v) => !v)} />
        )}
        {/* Every signed-in user gets the documentation, whatever the role or the model's flags. */}
        <a
          className="icon-btn"
          href={ACCESS_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Documentation (opens in a new tab)"
          title="Documentation"
        >
          <NavIcon name="help" />
        </a>
        <ThemeSwitcher />
      </div>
    </header>
  );
}
