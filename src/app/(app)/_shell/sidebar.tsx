"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { NavModel, NavSection } from "@/lib/nav/model";
import type { ProductMenuItem } from "@/lib/products/product-menu";
import type { ShellWorkspace } from "@/lib/nav/shell-data";
import { BrandMark } from "@/components/brand";
import { NavIcon } from "./nav-icons";
import { useLiveCount } from "./live-count";
import type { AccountState } from "@/lib/auth/account-state";

/** Brand names, not copy: never translated, never a message key. */
const PRODUCT_NAMES: Record<string, string> = {
  PORTAL: "Captivo Portal",
  ACCESS: "Captivo Access",
};

export type ShellView = "admin" | "user";

/**
 * The sidebar of the design hand-off: product switcher, workspace, the menu in
 * groups, and at the foot the console / User switch, named after the role (only for someone who has
 * both) and the signed-in person. Below 1000px it is a drawer, opened from the
 * header's menu button through <html data-nav-open>.
 */
export function Sidebar({ model, view, roleLabel, products, workspace, user, accountUrl, account }: {
  model: NavModel;
  view: ShellView;
  /** The console side of the view switch is named after the person's role (Admin, Operator, Auditor). */
  roleLabel: string;
  products: ProductMenuItem[];
  workspace: ShellWorkspace;
  user: { name: string; email: string };
  /** The Captivo account page, or null where there is no centre (self-hosted). */
  accountUrl: string | null;
  account: AccountState;
}) {
  const pathname = usePathname();
  const [menu, setMenu] = useState<null | "products" | "account">(null);
  const rootRef = useRef<HTMLElement>(null);
  const live = useLiveCount(model.showSearch);

  const sections: NavSection[] = view === "admin" && model.admin.length > 0 ? model.admin : model.user;
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const initials = (user.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();

  // Navigating closes the drawer and any open menu.
  useEffect(() => {
    document.documentElement.dataset.navOpen = "";
    setMenu(null);
  }, [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menu]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") document.documentElement.dataset.navOpen = ""; };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="sb-scrim" onClick={() => { document.documentElement.dataset.navOpen = ""; }} aria-hidden="true" />
      <aside className="sb" id="app-sidebar" ref={rootRef} aria-label="Main">
        <div className="sb-top">
          <button
            type="button"
            className="sb-product"
            aria-expanded={menu === "products"}
            onClick={() => setMenu((m) => (m === "products" ? null : "products"))}
          >
            <BrandMark size={30} />
            <span className="sb-product-name">
              <span className="sb-wordmark">Captivo</span>
              <span className="sb-product-code">Access</span>
            </span>
            <span className="sb-chev"><NavIcon name="chev" size={16} /></span>
          </button>
          {menu === "products" && (
            <div className="sb-pop sb-pop-products">
              <p className="sb-pop-h">Switch product</p>
              <div className="sb-pop-item current" aria-current="true">
                <BrandMark size={18} /> Captivo Access <span className="sb-here">Current</span>
              </div>
              {products.filter((p) => p.state !== "current").map((p) => (
                <a key={p.product} href="/go" className="sb-pop-item">
                  <BrandMark size={18} /> {PRODUCT_NAMES[p.product]}
                  {p.state === "setup" ? <span className="sb-here">Needs setup</span> : <NavIcon name="ext" size={14} />}
                </a>
              ))}
              {accountUrl && (
                <a href={accountUrl} className="sb-pop-item" target="_blank" rel="noopener noreferrer">
                  <BrandMark size={18} /> Captivo ID <NavIcon name="ext" size={14} />
                </a>
              )}
            </div>
          )}

          <div className="sb-ws" title={workspace.host ?? undefined}>
            <span className="sb-ws-tile" aria-hidden="true">{(workspace.name[0] ?? "A").toUpperCase()}</span>
            <span className="sb-ws-text">
              <b>{workspace.name}</b>
              {workspace.host && <span>{workspace.host}</span>}
            </span>
          </div>
        </div>

        <nav className="sb-nav">
          {sections.map((s) => (
            <div key={s.label} className="sb-group">
              <p className="sb-group-h">{s.label}</p>
              {s.items.map((it) => {
                const active = isActive(it.href);
                // The live count is polled in the browser, like the header pill;
                // sessions waiting for a moderator (a warn badge) come first.
                const liveCount = it.href === "/admin/live" && it.badgeTone !== "warn";
                const n = liveCount ? live : it.badge;
                const tone = liveCount ? "ok" : it.badgeTone;
                return (
                  <Link key={it.href} href={it.href} className={active ? "sb-link active" : "sb-link"} aria-current={active ? "page" : undefined}>
                    <NavIcon name={it.icon} />
                    <span className="sb-link-label">{it.label}</span>
                    {n ? <span className={`sb-badge ${tone ?? "muted"}`} title={it.badgeTitle} aria-label={it.badgeTitle}>{n}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sb-foot">
          {model.canSwitchView && model.admin.length > 0 && (
            <>
              <p className="sb-group-h">View</p>
              <div className="seg sb-view" role="group" aria-label="View">
                <Link href="/" className={view === "admin" ? "seg-opt on" : "seg-opt"} aria-pressed={view === "admin"}>{roleLabel}</Link>
                <Link href="/access" className={view === "user" ? "seg-opt on" : "seg-opt"} aria-pressed={view === "user"}>User</Link>
              </div>
            </>
          )}
          <button
            type="button"
            className={menu === "account" ? "sb-user open" : "sb-user"}
            aria-haspopup="menu"
            aria-expanded={menu === "account"}
            onClick={() => setMenu((m) => (m === "account" ? null : "account"))}
          >
            <span className="sb-avatar" aria-hidden="true">{initials}</span>
            <span className="sb-user-text">
              <b>{user.name}</b>
              <span>{user.email}</span>
            </span>
            <span className="sb-user-chev" aria-hidden="true"><NavIcon name="chev" size={14} /></span>
          </button>
          {menu === "account" && (
            <div className="sb-pop sb-pop-account" role="menu">
              <Link href="/settings/passkeys" className="sb-pop-item" role="menuitem"><NavIcon name="key" size={16} /> Passkeys</Link>
              <Link href="/settings/recovery" className="sb-pop-item" role="menuitem">
                <NavIcon name="shield" size={16} /> Recovery
                {!account.recoveryOn && <span className="sb-pop-dot" title="Recovery isn't set up" aria-label="not set up" />}
              </Link>
              <Link href={view === "admin" ? "/settings/preferences" : "/preferences"} className="sb-pop-item" role="menuitem"><NavIcon name="settings" size={16} /> Preferences</Link>
              {accountUrl && account.idLinked && (
                <>
                  <span className="sb-pop-sep" role="separator" />
                  <a href={accountUrl} className="sb-pop-item" role="menuitem" target="_blank" rel="noopener noreferrer">
                    <NavIcon name="users" size={16} /> Captivo account <span className="sb-pop-end"><NavIcon name="ext" size={14} /></span>
                  </a>
                </>
              )}
              <span className="sb-pop-sep" role="separator" />
              <SignOut />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="sb-pop-item danger"
      role="menuitem"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } finally {
          window.location.href = "/login";
        }
      }}
    >
      <NavIcon name="logout" size={16} /> Sign out
    </button>
  );
}
