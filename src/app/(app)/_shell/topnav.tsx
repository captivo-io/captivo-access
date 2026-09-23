"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";
import type { SearchRecord } from "@/lib/search";
import type { NavModel, NavGroup } from "@/lib/nav/model";
import type { ProductMenuItem } from "@/lib/products/product-menu";
import { BrandMark } from "@/components/brand";
import { NavIcon } from "./nav-icons";
import { CommandPalette } from "./command-palette";
import { NotificationBell } from "./notification-bell";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { LogoutButton } from "../logout-button";
import { TimezoneLabel } from "./effective-timezone";
import { LivePill } from "./live-pill";

/** Brand names, not copy: never translated, never a message key. */
const PRODUCT_NAMES: Record<string, string> = {
  PORTAL: "Captivo Portal",
  ACCESS: "Captivo Access",
};

export function TopNav({ model, records, role, userName, roleLabel, showLive, products, accountUrl }: {
  model: NavModel; records: SearchRecord[]; role: Role; userName: string; roleLabel: string; showLive: boolean;
  /** The Captivo account page, or null where there is no centre (self-hosted). */
  accountUrl?: string | null;
  products: ProductMenuItem[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null); // open dropdown label | "account" | null
  const [drawer, setDrawer] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  const isActive = (href: string) => href === "/" ? pathname === "/" : (pathname === href || pathname.startsWith(`${href}/`));
  const groupActive = (g: NavGroup) => g.columns.some((c) => c.items.some((it) => isActive(it.href)));

  // Close menus + drawer on navigation.
  useEffect(() => { setOpen(null); setDrawer(false); }, [pathname]);
  // Drive the CSS drawer via <html data-nav-open> (same mechanism the old sidebar used).
  useEffect(() => {
    document.documentElement.dataset.navOpen = drawer ? "1" : "";
    return () => { document.documentElement.dataset.navOpen = ""; };
  }, [drawer]);
  // Dismiss an open dropdown on outside-click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const initials = (userName.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();

  return (
    <header className="topnav" ref={rootRef}>
      <button className="tn-burger" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}>
        <span /><span /><span />
      </button>
      <Link href="/" className="tn-brand">
        <BrandMark size={30} />
        <span className="brand-word">Captivo</span>
        <span className="brand-access">Access</span>
      </Link>

      <nav className="tn-primary">
        {model.primary.map((it) => (
          <Link key={it.href} href={it.href} className={isActive(it.href) ? "tn-link active" : "tn-link"} aria-current={isActive(it.href) ? "page" : undefined}>
            {it.label}{it.badge ? <span className="tn-badge">{it.badge}</span> : null}
          </Link>
        ))}
        {model.groups.map((g) => (
          <div key={g.label} className="tn-menuwrap">
            <button className={`tn-link tn-trigger${groupActive(g) ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open === g.label} onClick={() => setOpen((v) => (v === g.label ? null : g.label))}>
              {g.label} <span className="tn-caret" aria-hidden="true">▾</span>
            </button>
            {open === g.label && (
              <div className="tn-mega" role="menu">
                <div className="tn-mega-cols" data-cols={g.columns.length}>
                  {g.columns.map((col) => (
                    <div key={col.heading} className="tn-mega-col">
                      <p className="tn-mega-h">{col.heading}</p>
                      {col.items.map((it) => (
                        <Link key={it.href} href={it.href} role="menuitem" className={isActive(it.href) ? "tn-mega-card active" : "tn-mega-card"}>
                          <span className="tn-mega-ic">{it.icon ? <NavIcon name={it.icon} /> : null}</span>
                          <span className="tn-mega-nm">{it.label}</span>
                          <span className="tn-mega-ds">{it.desc}</span>
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="tn-right">
        {showLive && <LivePill />}
        {model.showSearch && <CommandPalette records={records} role={role} />}
        {model.showNotifications && (
          <NotificationBell
            badge={model.notificationsBadge}
            open={open === "notifications"}
            onToggle={() => setOpen((v) => (v === "notifications" ? null : "notifications"))}
          />
        )}
        {/*
          The neighbouring group triggers carry aria-haspopup="menu" and this one
          deliberately does not, nor does its panel carry role="menu". Those
          values promise the ARIA menu pattern -- arrow-key navigation and a
          roving tabindex -- which none of the nav implements. Claiming it tells
          a screen-reader user to press keys that do nothing, which is worse than
          saying less: aria-expanded already carries the state, and the items are
          real links in ordinary tab order.

          This is a considered difference, not an oversight. Bringing the
          neighbours in line is the right cleanup; copying their overclaim here
          would have been the wrong direction.
        */}
        {products.length > 0 && (
          <div className="tn-menuwrap">
            <button
              className="tn-link tn-trigger"
              aria-expanded={open === "products"}
              onClick={() => setOpen((v) => (v === "products" ? null : "products"))}
            >
              Products <span className="tn-caret" aria-hidden="true">▾</span>
            </button>
            {open === "products" && (
              <div className="tn-menu tn-menu-right">
                {products.map((p) =>
                  p.state === "current" ? (
                    <div key={p.product} className="tn-menuitem" aria-current="true">
                      {PRODUCT_NAMES[p.product]} <span className="tn-badge">You are here</span>
                    </div>
                  ) : (
                    <a key={p.product} href="/go" className="tn-menuitem" onClick={() => setOpen(null)}>
                      {PRODUCT_NAMES[p.product]}
                      {p.state === "setup" && <span className="tn-badge">Needs setup</span>}
                    </a>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        <ThemeSwitcher />
        <div className="tn-menuwrap tn-account">
          <button className="tn-avatar" aria-haspopup="menu" aria-expanded={open === "account"} onClick={() => setOpen((v) => (v === "account" ? null : "account"))}>
            {initials}
          </button>
          {open === "account" && (
            <div className="tn-menu tn-menu-right" role="menu">
              <div className="tn-ident"><b>{userName}</b><span>{roleLabel}</span><span><TimezoneLabel /></span></div>
              <Link href="/access" role="menuitem" className="tn-menuitem">My access</Link>
              <Link href="/settings/passkeys" role="menuitem" className="tn-menuitem">Settings</Link>
              <Link href="/settings/preferences" role="menuitem" className="tn-menuitem">Preferences</Link>
              {/* Leaves this host, so a plain anchor rather than next/link --
                  and only when there is a centre to leave for. The account
                  page existed for two days with nothing anywhere linking to
                  it: the person who built it could not find it either. */}
              {accountUrl && (
                <a href={accountUrl} role="menuitem" className="tn-menuitem" target="_blank" rel="noopener noreferrer">
                  Captivo account ↗
                </a>
              )}
              <div className="tn-menu-foot"><LogoutButton /></div>
            </div>
          )}
        </div>
      </div>

      {/* Mobile drawer (shown via html[data-nav-open] in CSS) */}
      <div className="tn-scrim" onClick={() => setDrawer(false)} />
      <div className="tn-drawer">
        {model.primary.map((it) => (
          <Link key={it.href} href={it.href} className={isActive(it.href) ? "tn-dlink active" : "tn-dlink"}>{it.label}{it.badge ? <span className="tn-badge">{it.badge}</span> : null}</Link>
        ))}
        {model.groups.map((g) => (
          <div key={g.label} className="tn-dgroup">
            <div className="tn-dgroup-label">{g.label}</div>
            {g.columns.map((col) => (
              <div key={col.heading} className="tn-dcol">
                <div className="tn-dcol-label">{col.heading}</div>
                {col.items.map((it) => (
                  <Link key={it.href} href={it.href} className={isActive(it.href) ? "tn-dlink sub active" : "tn-dlink sub"}>{it.label}</Link>
                ))}
              </div>
            ))}
          </div>
        ))}
        <div className="tn-dgroup">
          <div className="tn-dgroup-label">Account</div>
          <Link href="/access" className="tn-dlink sub">My access</Link>
          <Link href="/settings/passkeys" className="tn-dlink sub">Settings</Link>
        </div>
      </div>
    </header>
  );
}
