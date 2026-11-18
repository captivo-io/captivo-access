"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Go to console" (setup complete) or "Hide setup, show console": both hide the card for the tenant. */
export function DismissSetup({ variant }: { variant: "finish" | "skip" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function dismiss() {
    setBusy(true);
    setFailed(false);
    const res = await fetch("/api/admin/onboarding/dismiss", { method: "POST" }).catch(() => null);
    if (res?.ok) {
      router.refresh();
      return;
    }
    setBusy(false);
    setFailed(true);
  }

  const label = variant === "finish" ? "Go to console →" : "Hide setup, show console";
  return (
    <span className="ob-dismiss">
      {failed && <span className="ob-err" role="alert">Couldn&apos;t save. Try again.</span>}
      <button type="button" className={variant === "finish" ? "btn ok" : "ob-skip"} onClick={dismiss} disabled={busy}>
        {label}
      </button>
    </span>
  );
}
