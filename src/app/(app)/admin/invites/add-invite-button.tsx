"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(app)/_shell/modal";
import { InviteForm } from "./invite-form";

export function AddInviteButton({ smtpEnabled, vendorOnly }: { smtpEnabled: boolean; vendorOnly: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Refresh on close so the newly-created invite shows in the list.
  function close() {
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        New invitation
      </button>
      <Modal open={open} onClose={close} title="New invitation" size="lg">
        <InviteForm smtpEnabled={smtpEnabled} vendorOnly={vendorOnly} />
      </Modal>
    </>
  );
}
