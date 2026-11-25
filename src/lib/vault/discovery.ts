// Account discovery: the accounts of a Linux server, read through the
// resource's administrator account (connector/discover.go), and "take over":
// make one of them a resource of its own whose password only Captivo knows.

/** Connectors that list a Linux server's accounts. */
export const DISCOVER_MIN_CONNECTOR = "2.72.0";
/** Connectors that list a Windows server's accounts. */
export const DISCOVER_WINDOWS_MIN_CONNECTOR = "2.75.0";
/** How many accounts one take-over handles. */
export const ADOPT_MAX = 20;

export type DiscoveredAccount = {
  name: string;
  uid: number;
  shell: string;
  home: string;
  admin?: boolean;
  login?: boolean;
  locked?: boolean;
  noPass?: boolean;
  passAgeDays: number;
};

export type DiscoveredRow = DiscoveredAccount & {
  /** The resource that already holds this account on this server, if any. */
  managedBy: { id: string; name: string } | null;
};

const NAME = /^[A-Za-z0-9._$][A-Za-z0-9._$-]{0,63}$/;

/** Reads the connector's list, keeping only what it should have sent. */
export function acceptAccounts(v: unknown): DiscoveredAccount[] {
  if (!Array.isArray(v)) return [];
  const out: DiscoveredAccount[] = [];
  for (const a of v.slice(0, 500)) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.name !== "string" || !NAME.test(o.name) || typeof o.uid !== "number") continue;
    out.push({
      name: o.name, uid: o.uid, shell: typeof o.shell === "string" ? o.shell.slice(0, 80) : "", home: typeof o.home === "string" ? o.home.slice(0, 120) : "",
      admin: o.admin === true, login: o.login === true, locked: o.locked === true, noPass: o.noPass === true,
      passAgeDays: typeof o.passAgeDays === "number" ? o.passAgeDays : -1,
    });
  }
  return out;
}

/** Why an account cannot be taken over, or null. */
export function adoptProblem(a: DiscoveredRow, administrator: string, platform: "linux" | "windows" = "linux"): string | null {
  const bare = (n: string) => n.trim().replace(/^.*\\/, "").toLowerCase();
  if (bare(a.name) === bare(administrator)) return "This is the administrator account Captivo signs in with; changing its password would lock Captivo out.";
  if (a.managedBy) return `Already a resource: ${a.managedBy.name}.`;
  if (platform === "windows") {
    if (!a.login) return "It is disabled or is not a normal account.";
    if (a.uid === 500) return "The built-in Administrator is not taken over here.";
    if (a.uid === 501) return "The built-in Guest is not taken over here.";
    return null;
  }
  if (!a.login) return "It has no shell to sign in with.";
  if (a.uid === 0) return "root is not taken over here.";
  return null;
}

/** What a taken-over account's resource is called. */
export function adoptedName(site: string, user: string): string {
  return `${site} · ${user}`.slice(0, 80);
}
