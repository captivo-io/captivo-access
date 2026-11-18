"use client";
import { useState } from "react";
import type { GroupMappingRow } from "@/lib/directory/mappings";
import { ConnectionCard, type DirectoryInitial, type ConnectorOption } from "./directory-form";
import { GroupMappings } from "./group-mappings";
import { ResolvePreview } from "./resolve-preview";

const CHECKLIST = [
  ["Connection settings", "Host, security and service account"],
  ["Connection test", "Verified through the connector"],
  ["Group mappings", "At least one group → role or resource"],
  ["Turn on integration", "Applied at sign-in"],
] as const;

/** The Directory page: the three numbered cards and the sticky SETUP checklist. */
export function DirectoryView({
  initial, configured, lastTestOk, lastTestDetail, connectors, mappings, sites,
}: {
  initial: DirectoryInitial;
  configured: boolean;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  connectors: ConnectorOption[];
  mappings: GroupMappingRow[];
  sites: { id: string; name: string }[];
}) {
  // What is saved, as the checklist reads it; the connection card updates it after a save or a test.
  const [saved, setSaved] = useState({ configured, enabled: initial.enabled, testOk: lastTestOk === true });
  const done = [saved.configured, saved.testOk, mappings.some((m) => m.enabled), saved.enabled];

  return (
    <div className="dr-grid">
      <div className="dr-main">
        <ConnectionCard
          initial={initial}
          connectors={connectors}
          lastTestOk={lastTestOk}
          lastTestDetail={lastTestDetail}
          onSaved={(s) => setSaved((v) => ({ ...v, configured: s.configured, enabled: s.enabled, testOk: s.changedConnection ? false : v.testOk }))}
          onTested={(ok) => setSaved((v) => ({ ...v, testOk: ok }))}
        />
        <GroupMappings mappings={mappings} sites={sites} />
        <ResolvePreview sites={sites} />
      </div>
      <aside className="dr-aside" aria-label="Setup">
        <span className="dr-sec">SETUP</span>
        <ol className="dr-check">
          {CHECKLIST.map(([label, sub], i) => (
            <li key={label} className={done[i] ? "done" : undefined}>
              <span className="dr-check-mark" aria-hidden="true">{done[i] ? "✓" : i + 1}</span>
              <span className="dr-check-t"><b>{label}</b><span>{sub}</span></span>
              <span className="sr-only">{done[i] ? "done" : "to do"}</span>
            </li>
          ))}
        </ol>
        <span className="dr-rule" />
        <p className="dr-how">The connector reaches your directory from inside the network; no inbound ports are needed. The bind password is stored encrypted.</p>
      </aside>
    </div>
  );
}
