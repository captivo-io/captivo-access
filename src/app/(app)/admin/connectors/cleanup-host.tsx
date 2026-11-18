"use client";

import { useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { buildConnectorCleanupCommand } from "@/lib/connector/repair";

/** The host side of removing a connector: the console cannot reach into the host, so it hands over the command. */
export function CleanupHostModal({ open, onClose, name, deleted = false }: { open: boolean; onClose: () => void; name?: string; deleted?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} title={deleted ? "Connector deleted: clean up its host" : "Clean up the connector's host"}>
      <p className="cell-sub" style={{ marginTop: 0 }}>
        {deleted ? <>{name ? <b>{name}</b> : "The connector"} can no longer connect, but its containers are still on the host. </> : null}
        Run this on the connector&apos;s host to remove its containers, data, networks and images.
      </p>
      <CommandBlock command={buildConnectorCleanupCommand()} title="connector-cleanup" />
      <p className="notice warn" style={{ marginTop: 12 }}>
        The <code>docker volume rm</code> line deletes the recordings stored on this connector and the only key that opens them. If you may need them,
        use <b>Backup &amp; restore</b> on this page first, or leave out <code>access_connector_data</code>.
      </p>
      <div className="row-actions">
        <button type="button" className="btn sm" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

export function CleanupHostButton({ className = "btn sm" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>Clean up the host</button>
      <CleanupHostModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
