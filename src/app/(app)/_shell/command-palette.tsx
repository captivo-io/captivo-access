"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";
import { can, type Capability } from "@/lib/auth/roles";
import type { SearchRecord } from "@/lib/search";
import { filterCommandItems, type CommandItem } from "@/lib/command";

const PAGES: { label: string; href: string; cap: Capability | null }[] = [
  { label: "Overview", href: "/", cap: null },
  { label: "My access", href: "/access", cap: null },
  { label: "Grants", href: "/admin/grants", cap: "read_console" },
  { label: "Connectors", href: "/admin/connectors", cap: "configure" },
  { label: "Resources", href: "/admin/sites", cap: "configure" },
  { label: "Notifications", href: "/admin/notifications", cap: "read_console" },
  { label: "Live sessions", href: "/admin/live", cap: "read_console" },
  { label: "Users", href: "/admin/users", cap: "configure" },
  { label: "Invites", href: "/admin/invites", cap: "configure" },
  { label: "Sessions", href: "/admin/sessions", cap: "configure" },
  { label: "Audit log", href: "/admin/audit", cap: "read_console" },
  { label: "Settings", href: "/settings/passkeys", cap: null },
];
const GROUP_FOR: Record<SearchRecord["type"], CommandItem["group"]> = {
  site: "Resources",
  connector: "Connectors",
  user: "Users",
};

// A small glyph per destination, keyed by page href (records fall back to their
// group's page icon). Kept here rather than on CommandItem so the shared search
// types stay presentation-free.
const CMD_ICONS: Record<string, string[]> = {
  "/": ["M3 11l9-7 9 7", "M5 10v9h14v-9"],
  "/access": ["M14 9a4 4 0 1 0-4 4h1v2h2v2h3v-4z"],
  "/admin/grants": ["M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z", "M9 12l2 2 4-4"],
  "/admin/connectors": ["M9 7V4M15 7V4", "M7 7h10v4a5 5 0 0 1-10 0z", "M12 16v4"],
  "/admin/sites": ["M4 5h16v5H4z", "M4 13h16v6H4z", "M8 7.5h.01M8 16h.01"],
  "/admin/notifications": ["M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z", "M10 20a2 2 0 0 0 4 0"],
  "/admin/live": ["M3 12h4l2 6 4-14 2 8h6"],
  "/admin/users": ["M16 19v-2a4 4 0 0 0-8 0v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
  "/admin/invites": ["M4 6h16v12H4z", "M4 7l8 6 8-6"],
  "/admin/sessions": ["M4 5h16v11H4z", "M9 20h6M12 16v4"],
  "/admin/audit": ["M6 3h9l4 4v14H6z", "M9 12h6M9 16h6M9 8h3"],
  "/settings/passkeys": ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M12 4v2M12 18v2M5 8l1.7 1M17.3 15L19 16M5 16l1.7-1M17.3 9L19 8"],
};
const GROUP_ICON: Record<string, string> = { Resources: "/admin/sites", Connectors: "/admin/connectors", Users: "/admin/users" };

function CmdIcon({ href, group }: { href: string; group: string }) {
  const paths = CMD_ICONS[href] ?? CMD_ICONS[GROUP_ICON[group] ?? ""];
  return (
    <span className="cmd-ico" aria-hidden="true">
      {paths && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {paths.map((d, i) => <path key={i} d={d} />)}
        </svg>
      )}
    </span>
  );
}

// No-op subscribe: the Mac/non-Mac platform never changes during a session,
// so this store never needs to notify listeners of an update.
function subscribeNever() {
  return () => {};
}
function getIsMacSnapshot() {
  return navigator.userAgent.includes("Mac");
}
function getIsMacServerSnapshot() {
  return false;
}

export function CommandPalette({ records, role }: { records: SearchRecord[]; role: Role }) {
  const [open, setOpen] = useState(false);
  // useSyncExternalStore (rather than a mount-effect + setState) avoids both
  // a hydration mismatch and an effect-triggered re-render.
  const isMac = useSyncExternalStore(subscribeNever, getIsMacSnapshot, getIsMacServerSnapshot);

  const items: CommandItem[] = useMemo(() => {
    const pages: CommandItem[] = PAGES.filter((p) => p.cap === null || can(role, p.cap)).map((p) => ({
      id: `page:${p.href}`, label: p.label, sub: null, href: p.href, group: "Pages",
    }));
    const recs: CommandItem[] = records.map((r) => ({
      id: `${r.type}:${r.id}`, label: r.label, sub: r.sub, href: r.href, group: GROUP_FOR[r.type],
    }));
    return [...pages, ...recs];
  }, [records, role]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button className="cmd-trigger" onClick={() => setOpen(true)} aria-label="Search">
        <svg className="cmd-trigger-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
        <span className="cmd-trigger-text">Search or run a command…</span>
        <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
      </button>
      {open && <PaletteOverlay items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

// Mounted only while the palette is open, so `query`/`active` start fresh
// every time — no reset-on-open effect needed.
function PaletteOverlay({ items, onClose }: { items: CommandItem[]; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => filterCommandItems(query, items), [query, items]);

  function select(item: CommandItem | undefined) {
    if (!item) return;
    onClose();
    router.push(item.href);
  }

  function onQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    setActive(0);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  const groups: { name: string; rows: { item: CommandItem; index: number }[] }[] = [];
  results.forEach((item, index) => {
    let g = groups.find((x) => x.name === item.group);
    if (!g) {
      g = { name: item.group, rows: [] };
      groups.push(g);
    }
    g.rows.push({ item, index });
  });

  // Portal to <body> so the fixed overlay escapes the topbar's containing block
  // (the topbar's backdrop-filter would otherwise clip inset:0 to the topbar box).
  return createPortal(
    <div className="cmd-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="cmd-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder="Jump to a page, resource, connector, or user…"
          value={query}
          onChange={onQueryChange}
          onKeyDown={onInputKey}
        />
        <div className="cmd-results" role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <div className="cmd-empty">No matches.</div>
          ) : (
            groups.map((g) => (
              <div key={g.name} className="cmd-section">
                <div className="cmd-group">{g.name}</div>
                {g.rows.map(({ item, index }) => (
                  <button
                    key={item.id}
                    className={`cmd-item${index === active ? " active" : ""}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseMove={() => setActive(index)}
                    onClick={() => select(item)}
                  >
                    <CmdIcon href={item.href} group={item.group} />
                    <span className="cmd-label">{item.label}</span>
                    {item.sub && <span className="cmd-sub">{item.sub}</span>}
                    {item.group !== "Pages" && <span className="cmd-type">{item.group.slice(0, -1)}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
