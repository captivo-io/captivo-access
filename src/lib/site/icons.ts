// Resource tiles (design hand-off 10, 7.19): a library icon in one of six
// colours, chosen automatically from the resource's name and address until an
// admin picks one, or the uploaded logo. Pure and shared by server and browser
// so every page shows the same tile.

export const ICON_PATHS: Record<string, string> = {
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  server: '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"/>',
  firewall: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.3h18M3 14.7h18M9 4v5.3M15 9.3v5.4M9 14.7V20"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  router: '<rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 16.5h.01M11 16.5h.01M17 13V6"/><path d="M14 8a4.2 4.2 0 0 1 6 0"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  layers: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5L12 21l9-4.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  storage: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18M7 8h.01M7 16h.01M11 8h6M11 16h6"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  chart: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 16v-4M12 16V8M17 16v-6"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  directory: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
};
export const ICON_NAMES = Object.keys(ICON_PATHS);

export const ICON_LABELS: Record<string, string> = {
  desktop: "Desktop", terminal: "Terminal", globe: "Web app", server: "Server", firewall: "Firewall", shield: "Security",
  router: "Network device", database: "Database", layers: "Virtualization", mail: "Mail", storage: "Storage / NAS",
  camera: "Camera / NVR", printer: "Printer", chart: "Monitoring", code: "Development", cube: "Container",
  directory: "Directory / AD", key: "Vault / Secrets", cloud: "Cloud", phone: "PBX / VoIP",
};

export const ICON_COLORS = ["blue", "violet", "green", "amber", "cyan", "slate"] as const;
export type IconColor = (typeof ICON_COLORS)[number];
export const LOGO_BACKGROUNDS = ["white", "tint", "none"] as const;
export type LogoBackground = (typeof LOGO_BACKGROUNDS)[number];

// Keyword rules: the last flag marks a weak match, used for web resources only.
const KEYWORDS: [RegExp, string, boolean?][] = [
  [/pfsense|opnsense|fortigate|firewall|sophos|palo ?alto|sonicwall/i, "firewall"],
  [/proxmox|vmware|esxi|vcenter|hyper-?v|xen|nutanix/i, "layers"],
  [/exchange|mail|smtp|imap|owa|outlook/i, "mail"],
  [/sql|postgres|mysql|maria|mongo|redis|oracle|\bdb\b/i, "database"],
  [/\bnas\b|synology|qnap|truenas|storage|backup|veeam/i, "storage"],
  [/camera|kamera|nvr|cctv|dvr|hikvision/i, "camera"],
  [/print|yaz[ıi]c[ıi]/i, "printer"],
  [/grafana|kibana|zabbix|prometheus|dashboard|monitor|prtg/i, "chart"],
  [/gitlab|github|gitea|jenkins|\bgit\b|sonar/i, "code"],
  [/docker|k8s|kube|portainer|rancher|container/i, "cube"],
  [/mikrotik|router|unifi|switch|cisco|ubiquiti|aruba/i, "router"],
  [/\bdc\b|\bdc-|ldap|active.?dir|domain/i, "directory"],
  [/vault|keepass|bitwarden|secret|parola/i, "key"],
  [/pbx|voip|3cx|asterisk|santral/i, "phone"],
  [/securify|waf|guard|antivir|edr/i, "shield", true],
  [/captivo|portal|cloud|on-?prem/i, "cloud", true],
];

/** What a resource is, for the automatic icon and its default colour. */
export type ResourceKind = "web" | "isolated" | "rdp" | "ssh" | "vnc" | "database";

export function autoIcon(text: string, kind: ResourceKind): string {
  const remote = kind === "rdp" || kind === "ssh" || kind === "vnc";
  const hit = KEYWORDS.find(([re, , weak]) => (!weak || !remote) && re.test(text));
  if (hit) return hit[1];
  return kind === "database" ? "database" : kind === "ssh" ? "terminal" : remote ? "desktop" : kind === "isolated" ? "shield" : "globe";
}

export function defaultColor(kind: ResourceKind): IconColor {
  return kind === "database" ? "green" : kind === "rdp" || kind === "ssh" || kind === "vnc" ? "violet" : "blue";
}

export interface TileIcon {
  name: string;
  color: IconColor;
  /** No icon picked: chosen from the name. */
  auto: boolean;
}

/** The tile for a resource: its picked icon, or the automatic one. */
export function resolveIcon(s: { name: string; target?: string | null; kind: ResourceKind; iconName?: string | null; iconColor?: string | null }): TileIcon {
  const picked = s.iconName && ICON_PATHS[s.iconName] ? s.iconName : null;
  const color = (ICON_COLORS as readonly string[]).includes(s.iconColor ?? "") ? (s.iconColor as IconColor) : defaultColor(s.kind);
  return { name: picked ?? autoIcon(`${s.name} ${s.target ?? ""}`, s.kind), color, auto: !picked };
}

/** From the stored site: web / isolated / rdp / ssh / vnc / database. */
export function kindOf(s: { accessMode: string; protocol?: string | null }): ResourceKind {
  if (s.accessMode === "ISOLATED") return "isolated";
  if (s.accessMode === "DATABASE") return "database";
  if (s.accessMode === "GATEWAY") {
    const p = (s.protocol ?? "").toUpperCase();
    return p === "SSH" ? "ssh" : p === "VNC" ? "vnc" : "rdp";
  }
  return "web";
}

/** Protocol shown under the name: HTTPS / HTTP / RDP / SSH / VNC / PostgreSQL (the resource form names a MySQL or SQL Server one itself). */
export function protoLabel(kind: ResourceKind, target: string | null | undefined): string {
  if (kind === "database") return "PostgreSQL";
  if (kind === "rdp" || kind === "ssh" || kind === "vnc") return kind.toUpperCase();
  return (target ?? "").startsWith("http://") ? "HTTP" : "HTTPS";
}

/** Slug for a managed public host, from the resource name (Turkish letters to ASCII). */
export function slugFromName(name: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u" };
  return name.replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => map[c] ?? c).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
