"use client";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { suggestedLocalPort, tunnelCommand, validLocalPort } from "@/lib/gateway/tcp-tunnel";

type Ticket = {
  code: string; expiresAt: string; jumpHost: string; jumpPort: number;
  targetHost: string; targetPort: number; fingerprint: string | null;
};

const ERRORS: Record<string, string> = {
  forbidden: "Your access to this resource isn't active right now.",
  recording_required: "Every session in this workspace must be recorded, and a tunnel can't be, so it is closed for now.",
  connector_outdated: "This resource's connector needs an update before a tunnel can reach it.",
  ssh_off: "Tunnels aren't set up on this service.",
};

const portKey = (siteId: string) => `captivo.tunnel-port.${siteId}`;

/**
 * "Connect" on a TCP tunnel resource: an ssh command that listens on the
 * person's own computer and carries their app's connections to the service.
 * Its ticket starts the tunnel within two minutes; the tunnel then stays
 * open while the window does and the access lasts.
 */
export function TunnelCommandButton({ href, siteId, siteName }: { href: string; siteId: string; siteName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ink sm" onClick={() => setOpen(true)} title="Get an ssh command that opens a tunnel to this service on your own computer.">Connect</button>
      {open && <TunnelCommandModal href={href} siteId={siteId} siteName={siteName} onClose={() => setOpen(false)} />}
    </>
  );
}

function TunnelCommandModal({ href, siteId, siteName, onClose }: { href: string; siteId: string; siteName: string; onClose: () => void }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const fetchTicket = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as Partial<Ticket> & { error?: string };
      if (!res.ok || !j.code) {
        setTicket(null);
        setError(ERRORS[j.error ?? ""] ?? "Couldn't get a command. Try again in a moment.");
      } else {
        setTicket(j as Ticket);
        setNow(Date.now());
      }
    } finally {
      setBusy(false);
    }
  }, [href]);

  useEffect(() => {
    try {
      setPort(localStorage.getItem(portKey(siteId)) ?? "");
    } catch {
      /* no storage: the suggested port */
    }
    void fetchTicket();
  }, [fetchTicket, siteId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  function onPort(v: string) {
    const digits = v.replace(/\D/g, "").slice(0, 5);
    setPort(digits);
    try {
      if (digits) localStorage.setItem(portKey(siteId), digits);
      else localStorage.removeItem(portKey(siteId));
    } catch {
      /* not remembered */
    }
  }

  const fallback = ticket ? suggestedLocalPort(ticket.targetPort) : 0;
  const typed = Number(port);
  const portBad = port !== "" && !validLocalPort(typed);
  const local = port !== "" && validLocalPort(typed) ? typed : fallback;
  const left = ticket ? Math.max(0, Math.round((new Date(ticket.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!ticket && left === 0;
  const cmd = ticket ? tunnelCommand({ code: ticket.code, jumpHost: ticket.jumpHost, jumpPort: ticket.jumpPort, targetHost: ticket.targetHost, targetPort: ticket.targetPort, localPort: local }) : "";

  return (
    <Modal open onClose={onClose} title={`Tunnel to ${siteName}`} subtitle="For your own app: run the command, then point the app at the address below." size="md">
      <div className="ssh-cmd">
        <label className="ssh-field">
          <span className="ssh-label">Port on your computer</span>
          <input className={portBad ? "input mono bad" : "input mono"} value={port} onChange={(e) => onPort(e.target.value)} placeholder={fallback ? String(fallback) : ""} inputMode="numeric" autoComplete="off" spellCheck={false} />
        </label>

        {error ? (
          <p className="ssh-err" role="alert">{error}</p>
        ) : !ticket ? (
          <p className="cell-sub">{busy ? "Getting a command…" : ""}</p>
        ) : (
          <>
            <div className={expired ? "ssh-box expired" : "ssh-box"}>
              <code>{cmd}</code>
              {!expired && <CopyButton value={cmd} />}
            </div>
            <p className={expired ? "ssh-timer bad" : left <= 30 ? "ssh-timer warn" : "ssh-timer"} aria-live="polite">
              {expired
                ? "This command has expired. A tunnel it opened stays open."
                : <>Run it within <b className="mono">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</b>.</>}
            </p>
            {expired && <button type="button" className="btn primary" disabled={busy} onClick={() => void fetchTicket()}>Get a new command</button>}
            <div className="tun-to">
              <span className="ssh-label">Then connect your app to</span>
              <span className="tun-addr"><code>localhost:{local}</code><CopyButton value={`localhost:${local}`} /></span>
            </div>
          </>
        )}

        <ul className="ssh-notes">
          <li>Leave the window open while you work; close it, or press Ctrl+C in it, to end the tunnel. It also ends when your access does.</li>
          <li>Your app signs in to the service as it always does. Captivo doesn&apos;t sign in for you.</li>
          <li>This tunnel isn&apos;t recorded. Captivo logs when it was open and how much data it carried.</li>
          <li>If the port is in use on your computer, the command stops with &ldquo;Address already in use&rdquo;: pick another port above.</li>
          {ticket?.fingerprint && <li>The first time, ssh asks whether to trust <span className="mono">{ticket.jumpHost}:{ticket.jumpPort}</span>. Its key is <span className="mono ssh-fp">{ticket.fingerprint}</span>.</li>}
          <li>On Windows the command works in PowerShell and Windows Terminal (OpenSSH is built in).</li>
        </ul>
      </div>
    </Modal>
  );
}
