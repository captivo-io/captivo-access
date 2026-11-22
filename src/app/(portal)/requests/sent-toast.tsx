"use client";
import { useEffect, useState } from "react";

/** "Request sent" after the request dialog brings the person here. */
export function SentToast({ approved = false }: { approved?: boolean }) {
  const [show, setShow] = useState(true);
  useEffect(() => {
    // Drop ?sent=1 from the address without a navigation (which would re-render
    // the page without it and take the toast away), so a reload stays quiet.
    window.history.replaceState(null, "", "/requests");
    const t = setTimeout(() => setShow(false), 2600);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="toast" role="status">
      <span aria-hidden="true">✓</span> {approved ? "Approved by its ticket: the access is in My access" : "Request sent: you are told when it is decided"}
    </div>
  );
}
