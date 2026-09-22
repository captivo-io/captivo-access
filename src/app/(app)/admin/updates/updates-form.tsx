"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/app/(app)/_shell/local-time";

export function UpdatesForm({
  initialEnabled,
  currentVersion,
  latestVersion,
  lastCheckedAt,
  lastCheckOk,
}: {
  initialEnabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setEnabled(next);
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        setEnabled(!next); // revert on failure
        setNotice("Couldn't save, please try again.");
      }
    } catch {
      setEnabled(!next);
      setNotice("Couldn't save, please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/updates/check", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (j.ok) setNotice(j.latestVersion ? `Latest release: ${j.latestVersion}.` : "Checked — no release found.");
      else setNotice(j.reason === "disabled" ? "Update checks are turned off." : "Couldn't reach GitHub — try again later.");
      router.refresh();
    } catch {
      setNotice("Couldn't reach GitHub — try again later.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="setting" style={{ marginBottom: "1rem" }}>
        <div className="setting-main">
          <div className="setting-label">Check GitHub for new releases</div>
          <div className="setting-hint">Checks GitHub for the latest release. No information about your installation is sent.</div>
        </div>
        <div className="setting-ctl">
          <label className="switch"><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} /><span className="track" /></label>
        </div>
      </div>

      <p className="cell-sub">
        Captivo Access: <strong>v{currentVersion}</strong>
        {latestVersion && <> · latest: <strong>v{latestVersion}</strong></>}
        {lastCheckedAt && <> · last checked <LocalTime iso={lastCheckedAt} /> {lastCheckOk === false ? "(failed)" : ""}</>}
      </p>

      <div className="row-actions">
        <button type="button" className="btn sm" onClick={checkNow} disabled={busy || !enabled}>
          {busy ? "Checking…" : "Check now"}
        </button>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
  );
}
