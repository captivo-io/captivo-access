"use client";

import { useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { CommandBlock } from "@/app/(app)/_shell/command-block";

export type BackupCommands = { keysBackup: string; fullBackup: string; keysRestore: string; fullRestore: string };

// Backing up what only the connector holds (src/lib/connector/backup.ts).
export function BackupConnectorButton({ commands }: { commands: BackupCommands }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>Backup &amp; restore</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Back up a connector">
        <p className="cell-sub" style={{ marginTop: 0 }}>
          Each connector keeps two keys that exist nowhere else — not with us either. The <b>recording key</b> opens
          every recording on that connector; the <b>vault key</b> opens the remote-desktop passwords saved for its
          resources. If the connector&apos;s disk is lost without a backup, its recordings can never be played again and
          those passwords must be entered again. Run these on each connector&apos;s host.
        </p>

        <h3>1. Back up the keys (do this once, and again after replacing a connector)</h3>
        <p className="cell-sub">Copies the two keys into <code>captivo-connector-keys/</code>. Store that folder somewhere safe and separate from the host — a password manager or an encrypted vault: whoever holds it together with the recordings can read them.</p>
        <CommandBlock command={commands.keysBackup} title="connector-keys-backup" />

        <h3>2. Back up the recordings too (optional, regularly)</h3>
        <p className="cell-sub">One archive with the keys and every recording on this connector (its sign-in token is left out). It can be large; schedule it like any other backup and keep it as safe as the keys.</p>
        <CommandBlock command={commands.fullBackup} title="connector-full-backup" />

        <h3>Restore</h3>
        <p className="cell-sub">
          On a <b>new host</b>, restore <b>before</b> running the install or re-pair command: a connector that starts
          without its keys makes new ones, and anything it records with those cannot be read once the old keys are
          back. Run in the folder that holds the backup, then use <b>Re-pair</b> on this page to sign the connector in.
        </p>
        <p className="cell-sub">Keys only:</p>
        <CommandBlock command={commands.keysRestore} title="connector-keys-restore" />
        <p className="cell-sub">Keys and recordings (replace the file name with your archive&apos;s):</p>
        <CommandBlock command={commands.fullRestore} title="connector-full-restore" />

        <div className="row-actions">
          <button type="button" className="btn sm" onClick={() => setOpen(false)}>Close</button>
        </div>
      </Modal>
    </>
  );
}
