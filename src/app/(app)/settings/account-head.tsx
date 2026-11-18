import Link from "next/link";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";

export type AccountTab = "passkeys" | "recovery" | "prefs";

/**
 * The head of every My account page (design hand-off 11, 7.24): eyebrow, title,
 * the page's action, and the Passkeys / Recovery / Preferences tab row. The tab
 * row replaces the old "My passkeys · Recovery · Preferences" text links.
 */
export function AccountHead({ tab, title, sub, workspace, recoveryOn, prefsHref = "/settings/preferences", action }: {
  tab: AccountTab;
  title: string;
  sub: string;
  workspace: string | null;
  recoveryOn: boolean;
  /** The portal keeps its own Preferences page, in the user view. */
  prefsHref?: string;
  action?: React.ReactNode;
}) {
  const tabs: { id: AccountTab; label: string; href: string; icon: "key" | "shield" | "settings"; dot?: boolean }[] = [
    { id: "passkeys", label: "Passkeys", href: "/settings/passkeys", icon: "key" },
    { id: "recovery", label: "Recovery", href: "/settings/recovery", icon: "shield", dot: !recoveryOn },
    { id: "prefs", label: "Preferences", href: prefsHref, icon: "settings" },
  ];
  return (
    <>
      <div className="page-head ac-head">
        <div>
          <div className="eyebrow">My account{workspace ? ` · ${workspace}` : ""}</div>
          <h1>{title}</h1>
          <p>{sub}</p>
        </div>
        {action}
      </div>
      <nav className="ac-tabs" aria-label="My account">
        {tabs.map((t) => (
          <Link key={t.id} href={t.href} className={t.id === tab ? "ac-tab on" : "ac-tab"} aria-current={t.id === tab ? "page" : undefined}>
            <NavIcon name={t.icon} size={15} />
            {t.label}
            {t.dot && <span className="ac-tab-dot" title="Not set up" />}
          </Link>
        ))}
      </nav>
    </>
  );
}
