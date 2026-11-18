"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useZone, fmt, hm } from "@/app/(app)/admin/audit/audit-zone";
import { updateStatus, checkIsStale, connectorVersionState } from "@/lib/updates/status";

type Toast = { msg: string; ok: boolean } | null;

const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
  </svg>
);

/** The status card, the check switch and the connector versions of the Updates page. */
export function UpdatesView({
  available, initialEnabled, running, latestVersion, latestUrl, lastCheckedAt, lastCheckOk, connectors,
}: {
  /** False when the update-check table can't be read: the feature is off. */
  available: boolean;
  initialEnabled: boolean;
  running: string;
  latestVersion: string | null;
  latestUrl: string | null;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  connectors: { id: string; name: string; version: string | null }[];
}) {
  const router = useRouter();
  const zone = useZone();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  // Set only after a check made on this page, so "just now" never renders on the server.
  const [checkedHere, setCheckedHere] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const autoRan = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const check = useCallback(async (quiet: boolean) => {
    setChecking(true);
    try {
      const res = await fetch("/api/admin/updates/check", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; latestVersion?: string | null; reason?: string };
      if (j.ok) {
        setCheckedHere(true);
        if (!quiet) {
          const s = updateStatus(running, j.latestVersion);
          setToast({ ok: true, msg: s === "behind" ? `Version ${j.latestVersion} is available` : j.latestVersion ? `Up to date · latest release v${String(j.latestVersion).replace(/^v/i, "")}` : "Checked: no release found" });
        }
      } else if (!quiet) {
        setToast({ ok: false, msg: j.reason === "disabled" ? "Update checks are turned off." : "Couldn't reach GitHub. Try again later." });
      }
      router.refresh();
    } catch {
      if (!quiet) setToast({ ok: false, msg: "Couldn't reach GitHub. Try again later." });
    } finally {
      setChecking(false);
    }
  }, [router, running]);

  // Opening the page checks by itself, at most once a day.
  useEffect(() => {
    if (autoRan.current || !available) return;
    autoRan.current = true;
    if (checkIsStale(initialEnabled, lastCheckedAt, Date.now())) void check(true);
  }, [available, initialEnabled, lastCheckedAt, check]);

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error();
      setToast({ ok: true, msg: next ? "Update checks turned on" : "Update checks turned off" });
      router.refresh();
    } catch {
      setEnabled(!next);
      setToast({ ok: false, msg: "Couldn't save. Try again." });
    } finally {
      setSaving(false);
    }
  }

  const status = updateStatus(running, latestVersion);
  const latest = latestVersion ? `v${latestVersion.replace(/^v/i, "")}` : null;
  const failed = lastCheckOk === false;
  let tone: "ok" | "warn" | "neutral" = "neutral";
  let pill = "Not checked";
  let line: string;
  if (!available) {
    line = "Update checks aren't available on this installation.";
  } else if (status === "behind") {
    tone = "warn"; pill = `Update available · ${latest}`;
    line = `A newer release, ${latest}, is out. The steps to upgrade are below.`;
  } else if (status === "current") {
    tone = "ok"; pill = "Up to date";
    line = "You are running the latest published release.";
  } else if (status === "ahead") {
    tone = "ok"; pill = "Up to date";
    line = `The running version is newer than the latest published release (${latest}).`;
  } else if (!enabled) {
    line = "Update checks are off. Turn them on to see when a new release is out.";
  } else if (failed) {
    line = "The last check couldn't reach GitHub. Try again.";
  } else {
    line = "No release information yet. Check now to compare.";
  }

  const lastCheck = checkedHere ? "just now"
    : lastCheckedAt ? `${fmt(lastCheckedAt, zone, { month: "short", day: "numeric", year: "numeric" })} · ${hm(lastCheckedAt, zone)}${failed ? " · failed" : ""}`
      : "never";

  return (
    <>
      <section className={`up-hero ${tone}`}>
        <div className="up-hero-top">
          <span className={`up-tile ${tone}`} aria-hidden="true">{tone === "warn" ? "↑" : tone === "ok" ? "✓" : "·"}</span>
          <div className="up-hero-t">
            <span className="up-eyebrow">Captivo Access</span>
            <span className="up-ver">
              <b>v{running.replace(/^v/i, "")}</b>
              <span className={`up-pill ${tone}`}>{pill}</span>
            </span>
            <span className="up-line">{line}</span>
          </div>
          <div className="up-actions">
            {status === "behind" && latestUrl && <a className="btn" href={latestUrl} target="_blank" rel="noreferrer">Release notes</a>}
            <button type="button" className="btn" onClick={() => void check(false)} disabled={checking || !enabled || !available}
              title={!enabled ? "Turn update checks on first" : undefined}>
              {checking ? <span className="up-spin" aria-hidden="true" /> : <RefreshIcon />}
              {checking ? "Checking…" : "Check now"}
            </button>
          </div>
        </div>

        <div className="up-strip">
          <div><span className="up-k">Running</span><span className="up-v">v{running.replace(/^v/i, "")}</span></div>
          <div><span className="up-k">Latest release</span><span className="up-v">{latest ?? "—"}</span></div>
          <div><span className="up-k">Last check</span><span className={failed && !checkedHere ? "up-v t-warn" : "up-v"}>{lastCheck}</span></div>
        </div>

        <div className="up-switch">
          <span className="up-switch-t">
            <b>Check GitHub for new releases</b>
            <span className="cell-sub">Looks at the latest public release at most once a day, when an admin opens this page. Nothing about your installation is sent.</span>
          </span>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Check GitHub for new releases"
            className={enabled ? "toggle on" : "toggle"} disabled={saving || !available} onClick={() => void toggle()}>
            <span />
          </button>
        </div>
      </section>

      <section className="up-card">
        <div className="up-card-head">
          <b>Connector versions</b>
          <Link href="/admin/connectors" className="up-link">Connectors →</Link>
        </div>
        {connectors.length === 0 ? (
          <p className="up-empty cell-sub">No connectors yet. Each connector&apos;s version shows here once it is paired.</p>
        ) : (
          connectors.map((c) => {
            const st = connectorVersionState(c.version, running);
            return (
              <div key={c.id} className="up-conn">
                <span className="up-conn-ic" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></svg>
                </span>
                <span className="up-conn-n">{c.name}</span>
                <span className="up-conn-v mono">
                  {c.version ?? "—"}
                  {st === "outdated" && <> <span className="t-muted">→</span> {running.replace(/^v/i, "")}</>}
                </span>
                <span className={`up-pill ${st === "current" ? "ok" : st === "outdated" ? "warn" : "neutral"}`}>
                  {st === "current" ? "Up to date" : st === "outdated" ? "Outdated" : "Unknown"}
                </span>
              </div>
            );
          })
        )}
      </section>

      {toast && <div className="toast" role="status"><span className={toast.ok ? undefined : "t-bad"}>{toast.ok ? "✓" : "!"}</span>{toast.msg}</div>}
    </>
  );
}
