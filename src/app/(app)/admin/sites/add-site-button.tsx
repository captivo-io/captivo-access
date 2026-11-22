"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { ResourceForm, type ResourceContext } from "./resource-form";

/** "+ Add resource" and the new-resource dialog (design hand-off 10, 7.20). */
export function AddSiteButton({ ctx, initialOpen = false, blockedReason = null }: { ctx: ResourceContext; initialOpen?: boolean; blockedReason?: string | null }) {
  // At the plan's cap the add would fail: the button says why instead.
  const [open, setOpen] = useState(initialOpen && !blockedReason);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <>
      <button type="button" className="btn primary" disabled={!!blockedReason} title={blockedReason ?? undefined} onClick={() => setOpen(true)}>+ Add resource</button>
      <Modal open={open} onClose={() => setOpen(false)} title="New resource" subtitle="Define the internal upstream reached through a connector." size="xl">
        {open && <ResourceForm ctx={ctx} onClose={() => setOpen(false)} onSaved={(m) => { setOpen(false); setToast(m); }} />}
      </Modal>
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </>
  );
}
