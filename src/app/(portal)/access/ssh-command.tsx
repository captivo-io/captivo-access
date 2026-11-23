"use client";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import { recordedHostKeyAlias, sshCommand } from "@/lib/gateway/native-ssh-command";

type Ticket = {
  code: string; expiresAt: string; jumpHost: string; jumpPort: number;
  targetHost: string; targetPort: number; fingerprint: string | null;
  /** Recorded: Captivo signs in as `username`; file transfer follows the resource. */
  recorded?: boolean; username?: string; fileTransfer?: "allow" | "no_upload" | "no_download" | "none";
};

const TRANSFER: Record<NonNullable<Ticket["fileTransfer"]>, string> = {
  allow: "File transfer (sftp, scp) works.",
  no_upload: "You can download files (sftp, scp) but not upload them.",
  no_download: "You can upload files (sftp, scp) but not download them.",
  none: "File transfer (sftp, scp) is off for this resource.",
};

const ERRORS: Record<string, string> = {
  forbidden: "Your access to this resource isn't active right now.",
  off: "This resource no longer allows your own SSH app.",
  recording_required: "Every session in this workspace must be recorded, so this resource opens only in the browser.",
  connector_outdated: "This resource's connector needs an update before your own SSH app can reach it.",
  vault_secret_reenter: "The saved account for this resource must be entered again by an admin.",
  ssh_off: "Connecting with your own SSH app isn't set up on this service.",
  rotated: "This resource's password changes automatically, so it opens only in the browser now. Ask an admin to turn recording back on for it.",
};

const userKey = (siteId: string) => `captivo.ssh-user.${siteId}`;

/**
 * "SSH" on a resource: a ready command for the person's own SSH client. The
 * command's jump user is a ticket that starts connections for two minutes;
 * after that a new one is a click away. They sign in to the server themselves.
 */
export function SshCommandButton({ href, siteId, siteName, recorded = false, sshRecorded = false }: { href: string; siteId: string; siteName: string; recorded?: boolean; sshRecorded?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)}
        title={sshRecorded ? "Connect with your own SSH app (OpenSSH, Termius, PuTTY). Captivo signs you in; the session is recorded." : "Connect with your own SSH app (OpenSSH, VS Code, Termius). You sign in to the server yourself."}>SSH</button>
      {open && <SshCommandModal href={href} siteId={siteId} siteName={siteName} recorded={recorded} sshRecorded={sshRecorded} onClose={() => setOpen(false)} />}
    </>
  );
}

function SshCommandModal({ href, siteId, siteName, recorded, sshRecorded, onClose }: { href: string; siteId: string; siteName: string; recorded: boolean; sshRecorded: boolean; onClose: () => void }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState("");
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
      setUser(localStorage.getItem(userKey(siteId)) ?? "");
    } catch {
      /* no storage: the field starts empty */
    }
    void fetchTicket();
  }, [fetchTicket, siteId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  function onUser(v: string) {
    setUser(v);
    try {
      localStorage.setItem(userKey(siteId), v);
    } catch {
      /* not remembered */
    }
  }

  const left = ticket ? Math.max(0, Math.round((new Date(ticket.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!ticket && left === 0;
  const rec = !!ticket?.recorded;
  const cmd = ticket ? sshCommand({
    code: ticket.code, jumpHost: ticket.jumpHost, jumpPort: ticket.jumpPort, targetHost: ticket.targetHost, targetPort: ticket.targetPort,
    user: rec ? ticket.username ?? "" : user, hostKeyAlias: rec ? recordedHostKeyAlias(ticket.jumpHost) : undefined,
  }) : "";

  return (
    <Modal open onClose={onClose} title={`SSH to ${siteName}`} subtitle={sshRecorded ? "With your own SSH app: OpenSSH in a terminal, Termius, PuTTY." : "With your own SSH app: OpenSSH in a terminal, VS Code, Termius."} size="md">
      <div className="ssh-cmd">
        {!rec && (
          <label className="ssh-field">
            <span className="ssh-label">Your user name on the server</span>
            <input className="input mono" value={user} onChange={(e) => onUser(e.target.value)} placeholder="USER" autoComplete="off" spellCheck={false} maxLength={64} />
          </label>
        )}

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
                ? "This command has expired. Connections it started keep running."
                : <>Run it within <b className="mono">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</b>. It can start more connections until then (scp, a second terminal).</>}
            </p>
            {expired && <button type="button" className="btn primary" disabled={busy} onClick={() => void fetchTicket()}>Get a new command</button>}
          </>
        )}

        {rec ? (
          <ul className="ssh-notes">
            <li>Captivo signs you in to the server as <span className="mono">{ticket?.username}</span>. No password or key is needed.</li>
            <li><b>This session is recorded</b>, like Open. It ends when your access ends.</li>
            <li>{TRANSFER[ticket?.fileTransfer ?? "none"]} Port forwarding and agent forwarding are off.</li>
            {ticket?.fingerprint && <li>The first time, your SSH app asks twice whether to trust Captivo&apos;s key, <span className="mono ssh-fp">{ticket.fingerprint}</span>: once for <span className="mono">{ticket.jumpHost}:{ticket.jumpPort}</span> and once as the server.</li>}
            <li>On Windows the command works in PowerShell and Windows Terminal (OpenSSH is built in).</li>
          </ul>
        ) : (
          <ul className="ssh-notes">
            <li>Sign in to the server with your own password or key. Captivo doesn&apos;t sign in for you.</li>
            <li>{recorded ? "Unlike Open, which is recorded, a session in your own SSH app isn't recorded." : "This session isn't recorded."} It ends when your access ends.</li>
            {ticket?.fingerprint && <li>The first time, your SSH app asks whether to trust <span className="mono">{ticket.jumpHost}:{ticket.jumpPort}</span>. Its key is <span className="mono ssh-fp">{ticket.fingerprint}</span>.</li>}
            <li>On Windows the command works in PowerShell and Windows Terminal (OpenSSH is built in).</li>
          </ul>
        )}
      </div>
    </Modal>
  );
}
