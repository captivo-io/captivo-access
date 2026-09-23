"use client";
import { useState } from "react";
import { GatewaySession } from "./session-client";
import type { GatewayProtocol } from "@/lib/gateway/paste-keys";
import { IsolatedSession } from "./isolated-client";

export function ConsentGate({ accessMode, siteId, siteName, recorded, clipboardMode, fileTransferMode, protocol }: { accessMode: "GATEWAY" | "ISOLATED"; siteId: string; siteName: string; recorded: boolean; clipboardMode: string; fileTransferMode: string; protocol?: GatewayProtocol }) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      await fetch(`/api/gateway/${siteId}/consent`, { method: "POST" });
    } catch {
      /* audit is best-effort; proceed regardless */
    }
    setAccepted(true);
  }

  if (accepted) {
    return accessMode === "ISOLATED"
      ? <IsolatedSession siteId={siteId} siteName={siteName} recorded={recorded} fileTransferMode={fileTransferMode} />
      : <GatewaySession siteId={siteId} siteName={siteName} recorded={recorded} clipboardMode={clipboardMode} protocol={protocol} />;
  }

  return (
    <div className="consent-gate">
      <div className="consent-card">
        <h1>This session is recorded</h1>
        <p>
          For security and compliance, your activity in this remote session is
          recorded. Continue only if you consent to being recorded.
        </p>
        <button type="button" className="btn primary" disabled={busy} onClick={accept}>
          {busy ? "Starting…" : "I understand — connect"}
        </button>
      </div>
    </div>
  );
}
