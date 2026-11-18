"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/app/(app)/_shell/confirm-dialog";
import { Modal } from "@/app/(app)/_shell/modal";
import { CleanupHostModal } from "./cleanup-host";

const MESSAGES: Record<string, string> = {
  has_sites: "This connector still has resources — move or remove them under Resources first.",
  not_revoked: "Revoke the connector before deleting it.",
};

export function DeleteConnectorButton({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const { confirm, dialog } = useConfirm();
  const router = useRouter();

  async function handleClick() {
    if (!(await confirm(`Permanently delete connector "${name}"? This can't be undone.`, { danger: true }))) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/connectors/${encodeURIComponent(id)}/delete`, { method: "POST" });
      const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !result?.ok) {
        setError((result?.error && MESSAGES[result.error]) || "Couldn't delete the connector, please try again.");
        return;
      }
      // The card goes on refresh, so hand over the host cleanup first.
      setDeleted(true);
    } catch {
      setError("Couldn't delete the connector, please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {dialog}
      <CleanupHostModal open={deleted} onClose={() => { setDeleted(false); router.refresh(); }} name={name} deleted />
      <span>
        <button type="button" className="btn sm danger" onClick={handleClick} disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </button>
        {error && <p className="notice error" role="alert">{error}</p>}
      </span>
    </>
  );
}

/**
 * A revoked connector that still has resources: deletes them (and their grants)
 * together with the connector, once its name is typed back.
 */
export function DeleteWithResourcesButton({ id, name, resources }: { id: string; name: string; resources: number }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const router = useRouter();
  const label = `${resources} resource${resources === 1 ? "" : "s"}`;

  async function go() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/connectors/${encodeURIComponent(id)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ withResources: true, confirmName: typed }) });
      const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !result?.ok) {
        setError(result?.error === "confirm_mismatch" ? "Type the connector's name exactly." : (result?.error && MESSAGES[result.error]) || "Couldn't delete the connector, please try again.");
        return;
      }
      setOpen(false);
      setDeleted(true);
    } catch {
      setError("Couldn't delete the connector, please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn sm danger" onClick={() => { setTyped(""); setError(null); setOpen(true); }}>Delete with its {label}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete "${name}" and its ${label}?`} size="md">
        <p className="cell-sub" style={{ marginTop: 0 }}>
          The {label} served by this connector are deleted with it, and so are their grants: people lose access to them at once.
          Recordings of past sessions stay. This can&apos;t be undone.
        </p>
        <label className="rs-bulk-to">
          <span>Type <b>{name}</b> to confirm</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Connector name" />
        </label>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="rq-foot">
          <span className="rq-status" />
          <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy || typed.trim() !== name.trim()} onClick={() => void go()}>
            {busy ? "Deleting…" : `Delete connector and ${label}`}
          </button>
        </div>
      </Modal>
      <CleanupHostModal open={deleted} onClose={() => { setDeleted(false); router.refresh(); }} name={name} deleted />
    </>
  );
}
