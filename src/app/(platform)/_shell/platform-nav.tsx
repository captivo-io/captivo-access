"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/brand";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { LogoutButton } from "@/app/(app)/logout-button";
import { TimezoneLabel } from "@/app/(app)/_shell/effective-timezone";

const LINKS = [
  { href: "/platform", label: "Overview", exact: true },
  { href: "/platform/tenants", label: "Tenants" },
  { href: "/platform/activity", label: "Activity" },
  { href: "/platform/admins", label: "Admins" },
  { href: "/platform/jobs", label: "Jobs" },
  { href: "/platform/settings", label: "Settings" },
];

// Platform console header: same visual system as the tenant console's TopNav
// (.topnav / .tn-*), flat links instead of mega-menus — the platform surface is
// small enough to fit in one row.
export function PlatformNav({ userName, userEmail, alerts }: { userName: string; userEmail: string; alerts: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  /**
   * THE MOBILE DRAWER, which this header was missing.
   *
   * globals.css hides `.tn-primary` below 900px and shows `.tn-burger` plus
   * `.tn-scrim` / `.tn-drawer` in its place -- but this component rendered only the
   * link row, so on a phone all six platform destinations (Overview, Tenants,
   * Activity, Admins, Jobs, Settings) disappeared and nothing replaced them. The
   * CSS was ready; the markup was not. This file was written from the tenant
   * console's TopNav, which renders all three, and the mobile half was dropped on
   * the way across.
   *
   * Driven through `<html data-nav-open>` rather than a local class, because that is
   * the mechanism the stylesheet already uses for the tenant console's drawer.
   */
  useEffect(() => {
    document.documentElement.dataset.navOpen = drawer ? "1" : "";
    return () => {
      document.documentElement.dataset.navOpen = "";
    };
  }, [drawer]);

  // A route change leaves it open otherwise -- navigation does not unmount it, so
  // the next page would render behind an open drawer.
  useEffect(() => {
    setDrawer(false);
    setOpen(false);
  }, [pathname]);

  // Escape closes it. A drawer with no keyboard way out traps anyone not using a
  // pointer.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const isActive = (href: string, exact?: boolean) => (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const initials = (userName.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();
  return (
    <header className="topnav" ref={rootRef}>
      {/* Shown by CSS below 900px, where .tn-primary is hidden. */}
      <button
        type="button"
        className="tn-burger"
        aria-label="Menu"
        aria-expanded={drawer}
        aria-controls="platform-drawer"
        onClick={() => setDrawer((v) => !v)}
      >
        <span /><span /><span />
      </button>
      <Link href="/platform" className="tn-brand">
        <BrandMark size={30} />
        <span className="brand-word">Captivo</span>
        <span className="brand-access">Platform</span>
      </Link>
      <nav className="tn-primary">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={isActive(l.href, l.exact) ? "tn-link active" : "tn-link"} aria-current={isActive(l.href, l.exact) ? "page" : undefined}>
            {l.label}{l.href === "/platform" && alerts > 0 ? <span className="tn-badge">{alerts}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="tn-right">
        <ThemeSwitcher />
        <div className="tn-menuwrap tn-account">
          <button className="tn-avatar" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{initials}</button>
          {open && (
            <div className="tn-menu tn-menu-right" role="menu">
              <div className="tn-ident"><b>{userName}</b><span>{userEmail}</span><span><TimezoneLabel /></span></div>
              <Link href="/platform/preferences" role="menuitem" className="tn-menuitem" onClick={() => setOpen(false)}>Preferences</Link>
              <div className="tn-menu-foot"><LogoutButton /></div>
            </div>
          )}
        </div>
      </div>

      {/* The drawer the stylesheet was already styling. Rendered always -- the id
          that aria-controls names has to exist even while closed, or the button's
          reference dangles -- and revealed by html[data-nav-open] below 900px. */}
      <div className="tn-scrim" onClick={() => setDrawer(false)} />
      <div className="tn-drawer" id="platform-drawer">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={isActive(l.href, l.exact) ? "tn-dlink active" : "tn-dlink"}
            aria-current={isActive(l.href, l.exact) ? "page" : undefined}
            onClick={() => setDrawer(false)}
          >
            {l.label}
            {l.href === "/platform" && alerts > 0 ? <span className="tn-badge">{alerts}</span> : null}
          </Link>
        ))}
      </div>
    </header>
  );
}
