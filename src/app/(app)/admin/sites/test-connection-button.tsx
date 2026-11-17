"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function decodedByteLength(base64: string): number {
  try {
    return atob(base64).length;
  } catch {
    return 0;
  }
}

export function TestConnectionButton({ siteId }: { siteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleClick() {
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sites/${siteId}/test`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (body?.error) {
        setResult(`Failed: ${body.error}`);
        return;
      }
      if (body?.ok === true) {
        setResult(typeof body.latencyMs === "number" ? `Reachable · ${body.latencyMs} ms` : "Reachable");
        return;
      }
      if (typeof body?.status === "number") {
        const bytes = typeof body.bodyPreview === "string" ? decodedByteLength(body.bodyPreview) : 0;
        setResult(`HTTP ${body.status} · ${bytes} byte(s) received${body.truncated ? " (truncated)" : ""}`);
        return;
      }
      setResult("Unexpected response, please try again.");
    } catch {
      setResult("Couldn't reach the test endpoint, please try again.");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <span className="test-conn">
      <button type="button" className="btn sm" onClick={handleClick} disabled={busy}>
        {busy ? "Testing…" : "Test connection"}
      </button>
      {result && (
        <p className="notice test-result" role="status">
          {result}
        </p>
      )}
    </span>
  );
}
