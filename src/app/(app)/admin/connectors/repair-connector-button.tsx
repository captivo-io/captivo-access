"use client";

import { useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { formatShellCommand } from "@/lib/format/docker-command";
import { UpdaterChoice } from "./remote-control";

type Repaired = { code: string; reconfigureCommand: string; reconfigureCommandManual: string; managerUrlIsLocal: boolean };

export function RepairConnectorButton({ id, className = "btn sm" }: { id: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [invalidateNow, setInvalidateNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Repaired | null>(null);
  const [withUpdater, setWithUpdater] = useState(true);

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/connectors/${id}/repair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invalidateNow }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.code) {
        setError(body?.error === "not_repairable" ? "A revoked connector can't be re-paired." : "Couldn't generate a re-pair code, please try again.");
        return;
      }
      setResult({ code: body.code, reconfigureCommand: body.reconfigureCommand, reconfigureCommandManual: body.reconfigureCommandManual ?? body.reconfigureCommand, managerUrlIsLocal: Boolean(body.managerUrlIsLocal) });
    } catch {
      setError("Couldn't generate a re-pair code, please try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setOpen(false);
    setInvalidateNow(false);
    setError(null);
    setResult(null);
  }

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>Re-pair</button>
      <Modal open={open} onClose={reset} title="Re-pair connector">
        {result ? (
          <div role="status" className="notice">
            <p>
              This re-pair code is shown only once — it&apos;s embedded in the command below. Run it on the
              connector&apos;s host to rotate its token; the connector keeps its identity, its resources, its
              recordings and its keys.
            </p>
            <UpdaterChoice on={withUpdater} onChange={setWithUpdater} />
            <CommandBlock
              command={withUpdater ? result.reconfigureCommand : result.reconfigureCommandManual}
              display={formatShellCommand(withUpdater ? result.reconfigureCommand : result.reconfigureCommandManual)}
              title="connector-repair"
            />
            {result.managerUrlIsLocal && (
              <p className="notice error">
                <code>MANAGER_URL</code> points at <code>localhost</code> — replace it with the manager&apos;s
                real address (set <code>MANAGER_PUBLIC_URL</code> in the server&apos;s <code>.env</code>).
              </p>
            )}
          </div>
        ) : (
          <div>
            <label className="field-label" style={{ display: "flex", gap: ".4rem", alignItems: "center" }}>
              <input type="checkbox" checked={invalidateNow} onChange={(e) => setInvalidateNow(e.target.checked)} />
              Invalidate the current token now (connector goes offline until re-paired)
            </label>
            <p className="cell-sub">
              Off: the current token keeps working until you redeem the new code (zero-downtime handoff). On: the
              current token dies immediately (use if it may be compromised).
            </p>
            <div className="row-actions">
              <button type="button" className="btn sm primary" disabled={busy} onClick={generate}>
                {busy ? "Generating…" : "Generate code"}
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={reset}>Cancel</button>
            </div>
            {error && <p className="notice error" role="alert">{error}</p>}
          </div>
        )}
      </Modal>
    </>
  );
}
