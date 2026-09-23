"use client";
import { useState } from "react";
import { Modal } from "@/app/(app)/_shell/modal";
import { SiteForm } from "./site-form";
import type { GuacParams } from "@/lib/gateway/guac-params";
import type { KeystrokeMode } from "@/lib/settings/platform";

export function AddSiteButton({
  connectors,
  recordingEnabled,
  recordingMode,
  keystrokeMode,
  guacDefaults,
  nativeGateway,
  hostSuffix,
  isolationEnabled,
}: {
  connectors: { id: string; name: string }[];
  recordingEnabled: boolean;
  recordingMode: string;
  keystrokeMode: KeystrokeMode;
  guacDefaults: GuacParams;
  nativeGateway: boolean;
  hostSuffix: string | null;
  isolationEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        Add resource
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add resource" size="lg">
        <SiteForm connectors={connectors} recordingEnabled={recordingEnabled} recordingMode={recordingMode} keystrokeMode={keystrokeMode} guacDefaults={guacDefaults} nativeGateway={nativeGateway} isolationEnabled={isolationEnabled} hostSuffix={hostSuffix} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}
