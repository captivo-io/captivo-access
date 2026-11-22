import { KIND_LABEL, readSnapshot } from "@/lib/ticketing/rules";

/** A grant's ticket: its number (a link when the system gave one), state, and whether it was checked. */
export function TicketChip({ ticketRef, ticket, verified, showState = true }: { ticketRef: string | null; ticket: unknown; verified: boolean; showState?: boolean }) {
  if (!ticketRef) return null;
  const t = readSnapshot(ticket);
  const checked = t && t.system !== "none";
  const title = [
    t?.title,
    checked ? (verified ? `Checked in ${KIND_LABEL[t.system]}` : `Not checked${t?.error ? `: ${t.error}` : ""}`) : "Ticket number (not checked)",
  ].filter(Boolean).join(" · ");
  const cls = checked && !verified ? "tk-ref unverified" : "tk-ref";
  const body = (
    <>
      {ticketRef}
      {showState && t?.state && <span className="tk-ref-state">{t.state}</span>}
      {checked && !verified && <span className="tk-ref-state">not checked</span>}
    </>
  );
  return t?.url
    ? <a className={cls} href={t.url} target="_blank" rel="noreferrer" title={title}>{body}</a>
    : <span className={cls} title={title}>{body}</span>;
}
