"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ConnectorForm } from "./connector-form";
import { DeletePairingButton } from "./delete-pairing-button";
import { LocalTime } from "@/app/(app)/_shell/local-time";

const PANEL_ID = "cn-install";

function showPanel() {
  const el = document.getElementById(PANEL_ID);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the highlight
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1800);
  el.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
}

/** The header's "Add connector": the install panel is on the page, so it scrolls there and lights it up. */
export function AddConnectorScroll() {
  return (
    <button
      type="button"
      className="btn primary"
      onClick={showPanel}
    >
      + Add connector
    </button>
  );
}

/**
 * Always at the bottom of the page (and the whole page when there is no
 * connector yet): name a connector, get its one-time install command, and see
 * the pairings still waiting for their host. While one waits, the page looks
 * again every 10 s so the new connector's card appears on its own.
 */
export function InstallPanel({ first, pending }: { first: boolean; pending: { id: string; name: string; createdAt: string; expiresAt: string }[] }) {
  const router = useRouter();
  const [k, setK] = useState(0);
  const waiting = pending.filter((p) => Date.parse(p.expiresAt) > Date.now()).length;
  // The Console setup card's "Add connector" links here as /admin/connectors#cn-install.
  useEffect(() => {
    if (window.location.hash === `#${PANEL_ID}`) showPanel();
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [waiting, router]);

  return (
    <section id={PANEL_ID} className="cn-install">
      <div className="cn-install-head">
        <span className="cn-plus" aria-hidden="true">+</span>
        <div>
          <h2>{first ? "Add your first connector" : "Add a new connector"}</h2>
          <p>Runs on any Linux host with Docker inside the network. It dials out over TLS: no inbound ports, no VPN.</p>
        </div>
      </div>
      <ConnectorForm key={k} onDone={() => { setK((n) => n + 1); router.refresh(); }} />
      {pending.length > 0 && (
        <ul className="cn-pending">
          {pending.map((p) => {
            const expired = Date.parse(p.expiresAt) < Date.now();
            return (
              <li key={p.id}>
                {expired ? <span className="rs-pill unknown">Expired</span> : <span className="rs-spin" aria-hidden="true" />}
                <b>{p.name}</b>
                <span className="t-muted">
                  {expired ? "pairing code expired" : <>Waiting for pairing · code valid until <LocalTime iso={p.expiresAt} /></>}
                </span>
                <span className="cn-spacer" />
                <DeletePairingButton id={p.id} name={p.name} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
