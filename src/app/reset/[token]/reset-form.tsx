"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";

const FAILED = "Couldn't save the new passkey. Try again, or ask your administrator for a new link.";

export function ResetPasskeyForm({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const start = await fetch("/api/auth/passkey-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!start.ok) {
        setError("This link no longer works. Ask your administrator for a new one.");
        return;
      }
      const optionsRes = await fetch("/api/auth/registration/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "recover" }),
      });
      const options = await optionsRes.json().catch(() => ({}));
      if (!optionsRes.ok) { setError(FAILED); return; }
      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch("/api/auth/registration/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "recover", response }),
      });
      const result = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !result?.ok) { setError(FAILED); return; }
      window.location.href = "/";
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <p className="notice error" role="alert">{error}</p>}
      <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
        {busy ? "Waiting for your device…" : "Create a new passkey"}
      </button>
    </>
  );
}
