import { can } from "@/lib/auth/roles";
import type { Role } from "@/generated/prisma/enums";
import { multiTenantEnabled } from "@/lib/tenant/enabled";

export type NavIconKey =
  | "home" | "chart" | "key" | "activity" | "video" | "list"
  | "plug" | "server" | "globe" | "shield"
  | "users" | "userPlus" | "folder" | "lock" | "monitor"
  | "mail" | "send" | "download"
  | "grid" | "inbox" | "clock" | "settings" | "check" | "ticket";

export type BadgeTone = "ok" | "warn" | "bad" | "muted" | "info";

export interface NavItem {
  label: string; href: string; icon: NavIconKey; badge?: number; badgeTone?: BadgeTone; badgeTitle?: string;
  /** A second count beside the first, in its own tone (Connectors: offline, then out of date). */
  badge2?: { n: number; tone: BadgeTone; title: string };
}
export interface NavSection { label: string; items: NavItem[] }
export interface NavModel {
  /** The console's menu (admins, operators, auditors). Empty for vendors. */
  admin: NavSection[];
  /** The person's own access: every signed-in user has it. */
  user: NavSection[];
  /** Both menus apply: the sidebar offers the console / User switch. */
  canSwitchView: boolean;
  showSearch: boolean;
  showNotifications: boolean;
  notificationsBadge: number;
}

export interface NavCounts {
  pending: number;
  unread: number;
  /** Grants waiting for a decision in open access reviews. */
  reviewPending?: number;
  /** Live sessions right now. */
  live?: number;
  /** Online connectors running an older version than this console. */
  outdatedConnectors?: number;
  /** Connectors that were connected and are not now (a new one waiting to be installed is not counted). */
  offlineConnectors?: number;
  /** Resources the last probe could not reach. */
  unreachableResources?: number;
  /** The person's own requests still waiting for a decision. */
  myPending?: number;
  /** Sessions waiting for a moderator, for someone who may moderate. */
  moderationWaiting?: number;
}

const badge = (n: number | undefined, tone: BadgeTone, title?: string): Pick<NavItem, "badge" | "badgeTone" | "badgeTitle"> =>
  n && n > 0 ? { badge: n, badgeTone: tone, ...(title ? { badgeTitle: `${n} ${title}` } : {}) } : {};

function connectorBadges(offline: number | undefined, outdated: number | undefined): Pick<NavItem, "badge" | "badgeTone" | "badgeTitle" | "badge2"> {
  const down = badge(offline, "bad", "offline");
  const old = badge(outdated, "warn", "need an update");
  if (!down.badge) return old;
  return old.badge ? { ...down, badge2: { n: old.badge, tone: "warn", title: old.badgeTitle! } } : down;
}

// The sidebar, grouped as the design hand-off lays it out. read_console gives
// Overview, Grants, Sessions and Audit (plus search and notifications);
// approve_grants adds the pending badge on Grants; configure adds Recordings
// and the Infrastructure, Identity and Platform groups. A zero badge is left
// out (a count of nothing is not news). Empty sections are dropped.
export function buildNavModel(role: Role, counts: NavCounts): NavModel {
  const read = can(role, "read_console");
  const config = can(role, "configure");
  const grants = can(role, "approve_grants");

  const admin: NavSection[] = [];
  if (read) {
    admin.push({ label: "Overview", items: [
      { label: "Console", href: "/", icon: "home" },
      { label: "Insights", href: "/admin/insights", icon: "chart" },
    ] });
    admin.push({ label: "Operate", items: [
      { label: "Grants", href: "/admin/grants", icon: "key", ...badge(grants ? counts.pending : 0, "warn", "waiting for a decision") },
      { label: "Access reviews", href: "/admin/reviews", icon: "check", ...badge(grants ? counts.reviewPending : 0, "warn", "grants to review") },
      { label: "Sessions", href: "/admin/live", icon: "activity", ...(counts.moderationWaiting ? badge(counts.moderationWaiting, "warn", "waiting for a moderator") : badge(counts.live, "ok")) },
      ...(config ? [{ label: "Recordings", href: "/admin/recordings", icon: "video" as const }] : []),
      { label: "Audit", href: "/admin/audit", icon: "list" },
    ] });
  }
  if (config) {
    admin.push({ label: "Infrastructure", items: [
      // Offline is a fault (red); out of date is a chore (amber). Both show when both apply.
      { label: "Connectors", href: "/admin/connectors", icon: "plug", ...connectorBadges(counts.offlineConnectors, counts.outdatedConnectors) },
      // Unreachable is a fault, not a total: red, and named on hover.
      { label: "Resources", href: "/admin/sites", icon: "server", ...badge(counts.unreachableResources, "bad", "unreachable") },
      // Self-host only: the operator runs DNS for the wildcard app domain. On
      // Cloud the platform provisions each tenant's namespace, nothing to do.
      ...(multiTenantEnabled() ? [] : [{ label: "Custom domain", href: "/admin/domain", icon: "globe" as const }]),
      { label: "Policy", href: "/admin/policy", icon: "shield" },
    ] });
    admin.push({ label: "Identity & access", items: [
      { label: "Users & vendors", href: "/admin/users", icon: "users" },
      { label: "Directory", href: "/admin/directory", icon: "folder" },
      { label: "Single sign-on", href: "/admin/sso", icon: "lock" },
      { label: "Agents", href: "/admin/agents", icon: "key" },
    ] });
    admin.push({ label: "Platform", items: [
      { label: "Email", href: "/admin/email", icon: "mail" },
      { label: "Log forwarding", href: "/admin/log-forwarding", icon: "send" },
      { label: "Ticketing", href: "/admin/ticketing", icon: "ticket" },
      { label: "Updates", href: "/admin/updates", icon: "download" },
    ] });
  }

  const user: NavSection[] = [{ label: "My access", items: [
    { label: "My access", href: "/access", icon: "grid" },
    { label: "My requests", href: "/requests", icon: "inbox", ...badge(counts.myPending, "warn", "waiting for a decision") },
    { label: "History", href: "/history", icon: "clock" },
    { label: "Preferences", href: "/preferences", icon: "settings" },
  ] }];

  return {
    admin,
    user,
    canSwitchView: read,
    showSearch: read,
    showNotifications: read,
    // Waiting access requests ring the bell too, for those who can decide them.
    notificationsBadge: read ? counts.unread + (grants ? counts.pending : 0) + (counts.moderationWaiting ?? 0) : 0,
  };
}

/** The label of the page at pathname, for the header breadcrumb. */
export function navLabel(model: NavModel, pathname: string): string | null {
  let best: NavItem | null = null;
  for (const s of [...model.admin, ...model.user]) {
    for (const it of s.items) {
      const hit = it.href === "/" ? pathname === "/" : pathname === it.href || pathname.startsWith(`${it.href}/`);
      if (hit && (!best || it.href.length > best.href.length)) best = it;
    }
  }
  if (best) return best.label;
  // Pages reached from the header and the account menu rather than the sidebar.
  const off = OFF_NAV.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return off?.[1] ?? null;
}

const OFF_NAV: [string, string][] = [
  ["/admin/notifications", "Notifications"],
  ["/settings", "My account"],
  ["/admin/workspace/close", "Close workspace"],
];
