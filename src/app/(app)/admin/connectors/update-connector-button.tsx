"use client";

import { useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CommandBlock } from "@/app/(app)/_shell/command-block";
import { formatShellCommand } from "@/lib/format/docker-command";

export function UpdateConnectorButton({
  command,
  managerUrlIsLocal,
  label = "Update",
  className = "btn sm",
}: {
  command: string;
  managerUrlIsLocal: boolean;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Update connector">
        <p className="cell-sub" style={{ marginTop: 0 }}>Run this on the connector&apos;s host. It keeps the connector&apos;s token, so no re-pairing.</p>
        <CommandBlock command={command} display={formatShellCommand(command)} title="connector-update" />
        <div className="row-actions">
          <button type="button" className="btn sm" onClick={() => setOpen(false)}>Close</button>
        </div>
        {managerUrlIsLocal && (
          <p className="notice error" style={{ marginBottom: 0 }}>
            <code>MANAGER_URL</code> points at <code>localhost</code> — replace it with the manager&apos;s
            real address (set <code>MANAGER_PUBLIC_URL</code> in the server&apos;s <code>.env</code>).
          </p>
        )}
      </Modal>
    </>
  );
}
