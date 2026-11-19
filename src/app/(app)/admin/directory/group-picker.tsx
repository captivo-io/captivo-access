"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isMapped, parentOf } from "@/lib/directory/group-pick";

type Group = { name: string; dn: string; description?: string };
type Found = { q: string; groups: Group[]; truncated: boolean; error: string | null };

const DEBOUNCE_MS = 250;

/**
 * "Group name or DN" with directory search: typing two or more characters asks
 * the directory (through the connector) for matching groups; picking one fills
 * in its full DN. Typing a name or DN by hand still works, also when the
 * directory can't be searched.
 */
export function GroupPicker({ value, onChange, mapped, labelledBy }: { value: string; onChange: (v: string) => void; mapped: string[]; labelledBy?: string }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const picked = useRef<string | null>(null);

  const q = value.trim();
  const searchable = q.length >= 2 && !q.includes("=");

  useEffect(() => {
    if (!searchable || picked.current === value) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/directory/groups?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        const body = await res.json().catch(() => ({}));
        setFound({ q, groups: body.groups ?? [], truncated: !!body.truncated, error: body.ok ? null : body.error || "The directory search is not available." });
        setActive(-1);
      } catch {
        if (!ctl.signal.aborted) setFound({ q, groups: [], truncated: false, error: "The directory search is not available." });
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { ctl.abort(); window.clearTimeout(t); };
  }, [q, searchable, value]);

  const groups = found && searchable ? found.groups : [];
  const show = open && searchable && (loading || found !== null);

  function pick(g: Group) {
    picked.current = g.dn;
    onChange(g.dn);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!show) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, groups.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && active >= 0 && groups[active]) { e.preventDefault(); pick(groups[active]); }
    else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div className="dr-gp">
      <input className="input mono" value={value} spellCheck={false} autoComplete="off"
        role="combobox" aria-labelledby={labelledBy} aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => { picked.current = null; onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey}
        placeholder="Type to search the directory, or paste a name or DN" />
      {show && (
        <div className="dr-gp-pop" id={listId} role="listbox" aria-label="Directory groups" onMouseDown={(e) => e.preventDefault()}>
          {loading && !found ? (
            <div className="dr-gp-note"><span className="dr-spin" aria-hidden="true" /> Searching the directory…</div>
          ) : found?.error ? (
            <div className="dr-gp-note">{found.error} You can still type the group name or DN.</div>
          ) : groups.length === 0 ? (
            <div className="dr-gp-note">{loading ? "Searching the directory…" : `No group matches “${found?.q}”. Adding it anyway matches it by name.`}</div>
          ) : (
            <>
              {groups.map((g, i) => {
                const already = isMapped(g.dn, mapped);
                return (
                  <button key={g.dn} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === active}
                    className={i === active ? "dr-gp-opt on" : "dr-gp-opt"} onMouseEnter={() => setActive(i)} onClick={() => pick(g)}>
                    <span className="dr-gp-name">{g.name}{already && <span className="dr-gp-tag">Already mapped</span>}</span>
                    <span className="dr-gp-dn mono" title={g.dn}>{parentOf(g.dn) || g.dn}</span>
                    {g.description && <span className="dr-gp-desc">{g.description}</span>}
                  </button>
                );
              })}
              {found?.truncated && <div className="dr-gp-note">Showing the first {groups.length}. Type more to narrow it down.</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
