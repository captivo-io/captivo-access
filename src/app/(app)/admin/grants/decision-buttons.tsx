"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DecisionButtons({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/grants/${grantId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision === "deny" ? { decision, reason } : { decision }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setError(b.error === "ticket_refused" && b.message ? `The ticket can't be used: ${b.message}` : b.error === "not_pending" ? "Already decided." : "Action failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (denying) {
    return (
      <div>
        <input
          type="text"
          className="input"
          placeholder="Reason (optional)"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Deny reason (optional)"
        />
        <div className="row-actions">
          <button className="btn sm danger" disabled={busy} onClick={() => decide("deny")}>Confirm deny</button>
          <button className="btn sm" disabled={busy} onClick={() => { setDenying(false); setReason(""); setError(null); }}>Cancel</button>
        </div>
        {error && <span className="notice error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="row-actions">
      <button className="btn sm primary" disabled={busy} onClick={() => decide("approve")}>Approve</button>
      <button className="btn sm danger" disabled={busy} onClick={() => setDenying(true)}>Deny</button>
      {error && <span className="notice error">{error}</span>}
    </div>
  );
}
