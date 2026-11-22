"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The server's SSH host key Captivo kept on first contact (a recorded native
 * SSH session or a password rotation). A different key is refused until an
 * admin forgets this one, after a rebuild or a deliberate key change.
 */
export function SshHostKeyLine({ siteId, fingerprint }: { siteId: string; fingerprint: string }) {
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  async function forget() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sites/${siteId}/ssh-host-key`, { method: "DELETE" });
      if (res.ok) {
        setGone(true);
        router.refresh();
      }
    } finally {
      setBusy(false);
      setAsk(false);
    }
  }
  if (gone) return <p className="rf-msg">The server&apos;s host key was forgotten. The next connection keeps the key it shows.</p>;
  return (
    <div className="rf-hostkey">
      <span className="rf-hostkey-t">
        <b>Server&apos;s SSH host key</b>
        <span className="mono">{fingerprint}</span>
        <span className="cell-sub">Kept when Captivo first signed in. A server showing a different key is refused; forget it only if the server was rebuilt or its key replaced on purpose.</span>
      </span>
      <button type="button" className={ask ? "btn sm danger" : "btn sm"} disabled={busy} onClick={() => (ask ? void forget() : setAsk(true))}>
        {ask ? "Sure? Forget it" : "Forget"}
      </button>
    </div>
  );
}
