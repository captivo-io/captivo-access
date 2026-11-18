"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { buildConnectorCleanupCommand } from "@/lib/connector/repair";

type T = { id: string; slug: string; name: string; deleted: boolean; status: string };

export function DangerZone({ tenant }: { tenant: T }) {
  const router = useRouter();
  const [confirmSlug, setConfirmSlug] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(path: "delete" | "restore" | "purge") {
    setBusy(path); setErr(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenant.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmSlug }) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(b?.error === "confirm_mismatch" ? "Type the tenant slug exactly to confirm." : `Failed: ${b?.error ?? res.status}`); return; }
      if (path === "purge") { router.push("/platform/tenants"); return; }
      setConfirmSlug("");
      router.refresh();
    } finally { setBusy(null); }
  }

  return (
    <div className="card" style={{ borderColor: "var(--danger)" }}>
      <div className="card-head"><div><h2>Danger zone</h2><div className="sub">Irreversible or disruptive actions. Every one is recorded in the platform audit chain.</div></div></div>
      <div className="settings">
        {!tenant.deleted ? (
          <div className="setting setting-stack">
            <div className="setting-main"><span className="setting-label">Delete this tenant</span><div className="setting-hint">Soft delete: the console and every app stop resolving immediately, all sessions end, and the data is kept for 30 days so it can be restored. After that the platform-ops cron purges it permanently.</div></div>
            <div className="setting-ctl"><input className="input" placeholder={`type "${tenant.slug}" to confirm`} value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} /><button type="button" className="btn danger" disabled={busy !== null || confirmSlug !== tenant.slug} onClick={() => act("delete")}>{busy === "delete" ? "Deleting…" : "Delete tenant"}</button></div>
          </div>
        ) : (
          <>
            <div className="setting"><div className="setting-main"><span className="setting-label">Restore this tenant</span><div className="setting-hint">Brings the console, apps and data back exactly as they were.</div></div><div className="setting-ctl"><button type="button" className="btn primary" disabled={busy !== null} onClick={() => act("restore")}>{busy === "restore" ? "Restoring…" : "Restore"}</button></div></div>
            <div className="setting setting-stack"><div className="setting-main"><span className="setting-label">Purge now</span><div className="setting-hint">Permanently removes every row of this tenant (users, resources, audit, recordings). Cannot be undone. Otherwise happens automatically 30 days after deletion.</div></div><div className="setting-ctl"><input className="input" placeholder={`type "${tenant.slug}" to confirm`} value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} /><button type="button" className="btn danger" disabled={busy !== null || confirmSlug !== tenant.slug} onClick={() => act("purge")}>{busy === "purge" ? "Purging…" : "Purge permanently"}</button></div></div>
          </>
        )}
        <div className="setting setting-stack">
          <div className="setting-main"><span className="setting-label">Connector hosts</span><div className="setting-hint">Deleting or purging the tenant stops its connectors from connecting, but their containers stay on the customer&apos;s hosts. Give the customer this command to run on each host; it removes the containers, their recordings and keys, the networks and the images.</div></div>
          <CommandBlock command={buildConnectorCleanupCommand()} title="connector-cleanup" />
        </div>
      </div>
      {err && <p className="notice error" style={{ marginTop: 10 }}>{err}</p>}
    </div>
  );
}
