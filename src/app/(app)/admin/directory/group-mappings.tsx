"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GroupMappingRow } from "@/lib/directory/mappings";

type SiteOption = { id: string; name: string };
type MappableRole = "ADMIN" | "OPERATOR" | "AUDITOR";

// Only these roles can come from a directory group (the API refuses the rest).
const ROLES: { key: MappableRole; label: string }[] = [
  { key: "ADMIN", label: "Admin" },
  { key: "OPERATOR", label: "Operator" },
  { key: "AUDITOR", label: "Auditor" },
];
const roleLabel = (r: string | null) => ROLES.find((x) => x.key === r)?.label ?? r ?? "—";

// The API answers with a sentence ("That group is already mapped to this target.").
const addError = (msg: string | undefined) => msg || "Couldn't add the mapping.";

/** Card 2: 03 · Group mappings. */
export function GroupMappings({ mappings, sites }: { mappings: GroupMappingRow[]; sites: SiteOption[] }) {
  const router = useRouter();
  const [groupDN, setGroupDN] = useState("");
  const [kind, setKind] = useState<"ROLE" | "SITE">("ROLE");
  const [role, setRole] = useState<MappableRole>("OPERATOR");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [siteQ, setSiteQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownSites = useMemo(() => {
    const t = siteQ.trim().toLowerCase();
    return t ? sites.filter((s) => s.name.toLowerCase().includes(t)) : sites;
  }, [siteQ, sites]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!groupDN.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/directory/mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupDN: groupDN.trim(), kind, role: kind === "ROLE" ? role : null, siteId: kind === "SITE" ? siteId : null, enabled: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) { setError(addError(body.error)); return; }
      setGroupDN("");
      router.refresh();
    } catch {
      setError("Couldn't add the mapping.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(m: GroupMappingRow) {
    await fetch(`/api/admin/directory/mappings/${m.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !m.enabled }),
    }).catch(() => null);
    router.refresh();
  }

  async function remove(m: GroupMappingRow) {
    await fetch(`/api/admin/directory/mappings/${m.id}`, { method: "DELETE" }).catch(() => null);
    router.refresh();
  }

  return (
    <section className="dr-card">
      <div className="dr-card-head col">
        <span className="dr-sec">03 · MAPPING</span>
        <b className="dr-card-title">Group mappings</b>
        <span className="dr-card-sub">Link an AD group to a console role or a resource. If a user is in several groups, the highest role wins.</span>
      </div>
      <div className="dr-body">
        {mappings.length === 0 ? (
          <div className="dr-nomap">
            <span className="dr-nomap-ic" aria-hidden="true">!</span>
            <span><b>No mappings yet</b><span>Without a mapping, directory users can&apos;t sign in. Link at least one group to a role.</span></span>
          </div>
        ) : (
          <div className="dr-maps">
            {mappings.map((m) => (
              <div key={m.id} className={m.enabled ? "dr-map" : "dr-map off"}>
                <span className="dr-map-g">
                  <span className="dr-map-ic" aria-hidden="true">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 20a6.4 6.4 0 0 0-2.4-5" /></svg>
                  </span>
                  <span className="mono" title={m.groupDN}>{m.groupDN}</span>
                </span>
                <span className="dr-map-arrow" aria-hidden="true">→</span>
                {m.kind === "ROLE" ? (
                  <span className={`dr-target role-${(m.role ?? "").toLowerCase()}`}><span className="mono">ROLE</span>{roleLabel(m.role)}</span>
                ) : (
                  <span className="dr-target res"><span className="mono">RESOURCE</span>{m.siteName ?? "Deleted resource"}</span>
                )}
                <button type="button" className={m.enabled ? "dr-map-en on" : "dr-map-en"} aria-pressed={m.enabled} onClick={() => void toggle(m)}
                  title={m.enabled ? "Applied at sign-in. Click to pause it." : "Paused. Click to apply it again."}>
                  {m.enabled ? "On" : "Paused"}
                </button>
                <button type="button" className="dr-map-x" aria-label={`Remove mapping for ${m.groupDN}`} onClick={() => void remove(m)}>×</button>
              </div>
            ))}
          </div>
        )}

        <form className="dr-add" onSubmit={add}>
          <label className="dr-field"><span className="dr-label">Group name or DN</span>
            <input className="input mono" value={groupDN} onChange={(e) => setGroupDN(e.target.value)} spellCheck={false}
              placeholder="Captivo-Admins  ·  CN=Captivo-Admins,OU=Groups,DC=corp,DC=local" />
          </label>
          <div className="dr-add-row">
            <div className="dr-field">
              <span className="dr-label">Grants</span>
              <div className="seg" role="group" aria-label="Grants">
                <button type="button" className={kind === "ROLE" ? "seg-opt on" : "seg-opt"} aria-pressed={kind === "ROLE"} onClick={() => setKind("ROLE")}>Console role</button>
                <button type="button" className={kind === "SITE" ? "seg-opt on" : "seg-opt"} aria-pressed={kind === "SITE"} onClick={() => setKind("SITE")}>Resource access</button>
              </div>
            </div>
            <div className="dr-field dr-add-target">
              <span className="dr-label">{kind === "ROLE" ? "Role" : "Resource"}</span>
              {kind === "ROLE" ? (
                <div className="dr-pills" role="radiogroup" aria-label="Role">
                  {ROLES.map((r) => (
                    <button key={r.key} type="button" role="radio" aria-checked={role === r.key} className={role === r.key ? "fpill on" : "fpill"} onClick={() => setRole(r.key)}>{r.label}</button>
                  ))}
                </div>
              ) : sites.length === 0 ? (
                <span className="dr-hint">No resources yet.</span>
              ) : (
                <>
                  {sites.length > 8 && <input className="input dr-site-q" value={siteQ} onChange={(e) => setSiteQ(e.target.value)} placeholder="Search resources…" aria-label="Search resources" />}
                  <div className="dr-pills" role="radiogroup" aria-label="Resource">
                    {shownSites.map((s) => (
                      <button key={s.id} type="button" role="radio" aria-checked={siteId === s.id} className={siteId === s.id ? "fpill on" : "fpill"} onClick={() => setSiteId(s.id)}>{s.name}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button type="submit" className="btn primary" disabled={busy || !groupDN.trim() || (kind === "SITE" && !siteId)}>{busy ? "Adding…" : "+ Add mapping"}</button>
          </div>
          {error && <p className="notice error" role="alert">{error}</p>}
        </form>
      </div>
    </section>
  );
}
