"use client";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CopyButton } from "@/app/(app)/_shell/copy-button";

type Kubeconfig = {
  kubeconfig: string; fileName: string; context: string; server: string; expiresAt: string;
  namespaces: string[]; readOnly: boolean; portForward: boolean; actsAs: string | null; recorded: boolean;
};
type Os = "unix" | "windows";

const ERRORS: Record<string, string> = {
  forbidden: "Your access to this cluster isn't active right now.",
  connector_outdated: "This cluster's connector needs an update before you can connect.",
  vault_secret_reenter: "This cluster's saved token needs to be entered again by an administrator.",
};

/**
 * "Connect" on a Kubernetes resource: a kubeconfig for the person's own
 * kubectl, Lens, k9s or Helm. Its token works for hours (until access or this
 * sign-in ends); Captivo signs every request in to the cluster for them.
 */
export function KubeConnectButton({ href, siteName }: { href: string; siteName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ink sm" onClick={() => setOpen(true)} title="Get a kubeconfig for your own kubectl, Lens, k9s or Helm.">Connect</button>
      {open && <KubeConnectModal href={href} siteName={siteName} onClose={() => setOpen(false)} />}
    </>
  );
}

function left(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function KubeConnectModal({ href, siteName, onClose }: { href: string; siteName: string; onClose: () => void }) {
  const [k, setK] = useState<Kubeconfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [os, setOs] = useState<Os>(() => (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "windows" : "unix"));
  const [now, setNow] = useState(() => Date.now());

  const fetchConfig = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as Partial<Kubeconfig> & { error?: string };
      if (!res.ok || !j.kubeconfig) {
        setK(null);
        setError(ERRORS[j.error ?? ""] ?? "Couldn't get a kubeconfig. Try again in a moment.");
      } else {
        setK(j as Kubeconfig);
        setNow(Date.now());
      }
    } finally {
      setBusy(false);
    }
  }, [href]);

  useEffect(() => { void fetchConfig(); }, [fetchConfig]);
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  function download() {
    if (!k) return;
    const url = URL.createObjectURL(new Blob([k.kubeconfig], { type: "application/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = k.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const expired = !!k && Date.parse(k.expiresAt) <= now;
  const until = k ? new Date(k.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const use = !k ? "" : os === "windows"
    ? `$env:KUBECONFIG = "$HOME\\Downloads\\${k.fileName}"\nkubectl get pods`
    : `export KUBECONFIG=~/Downloads/${k.fileName}\nkubectl get pods`;

  return (
    <Modal open onClose={onClose} title={`Connect to ${siteName}`} subtitle="With your own kubectl, Lens, k9s or Helm." size="md">
      <div className="ssh-cmd">
        {error ? (
          <p className="ssh-err" role="alert">{error}</p>
        ) : !k ? (
          <p className="cell-sub">{busy ? "Getting a kubeconfig…" : ""}</p>
        ) : (
          <>
            <div className="kube-get">
              <button type="button" className="btn primary" disabled={expired} onClick={download}>Download kubeconfig</button>
              <span className="cell-sub mono">{k.fileName}</span>
            </div>
            <div className="seg" role="tablist" aria-label="Your computer">
              {([["unix", "macOS / Linux"], ["windows", "Windows (PowerShell)"]] as const).map(([v, l]) => (
                <button key={v} type="button" role="tab" aria-selected={os === v} className={os === v ? "seg-opt on" : "seg-opt"} onClick={() => setOs(v)}>{l}</button>
              ))}
            </div>
            <div className={expired ? "ssh-box expired" : "ssh-box"}><code className="kube-use">{use}</code>{!expired && <CopyButton value={use} />}</div>
            <details className="kube-raw">
              <summary>Show the kubeconfig</summary>
              <div className="ssh-box"><code className="kube-use">{k.kubeconfig}</code>{!expired && <CopyButton value={k.kubeconfig} />}</div>
            </details>
            <p className={expired ? "ssh-timer bad" : "ssh-timer"} aria-live="polite">
              {expired
                ? "This kubeconfig has expired. Get a new one to keep working."
                : <>Works until <b className="mono">{until}</b> (in {left(Date.parse(k.expiresAt) - now)}), as long as your access and this sign-in last.</>}
            </p>
            {expired && <button type="button" className="btn primary" disabled={busy} onClick={() => void fetchConfig()}>Get a new kubeconfig</button>}
          </>
        )}
        <ul className="ssh-notes">
          <li>Captivo signs your requests in to the cluster{k?.actsAs ? <> as <span className="mono">{k.actsAs}</span></> : ""}; you don&apos;t need a token of your own.</li>
          {k?.readOnly && <li>Read only: you can get, list and watch. Changes, <span className="mono">kubectl exec</span> and secrets are refused.</li>}
          {k && k.namespaces.length > 0 && <li>Namespaces you can reach: <span className="mono">{k.namespaces.join(", ")}</span>. Name one with <span className="mono">-n</span>; requests across all namespaces are refused.</li>}
          {k && !k.readOnly && !k.portForward && <li><span className="mono">kubectl port-forward</span> is off for this cluster.</li>}
          <li>{k?.recorded ? <>Every request is logged, and <span className="mono">kubectl exec</span> sessions are recorded and may be watched live.</> : "Your sessions are logged; the requests are not."} Access ends when your access ends.</li>
          <li>The token in the file is yours alone: don&apos;t share it or commit it; get a new file instead of keeping it.</li>
        </ul>
      </div>
    </Modal>
  );
}
