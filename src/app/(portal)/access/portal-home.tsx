import type { IconColor } from "@/lib/site/icons";
import { RequestAccessButton } from "./request-access-button";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { AccessCards } from "./access-cards";
import { Empty } from "@/app/(app)/_console/console-home";
import { NavIcon } from "@/app/(app)/_shell/nav-icons";
import type { Remaining } from "@/lib/portal/time-remaining";
import type { StatusLine } from "@/lib/portal/security-status";

export interface CardVM {
  id: string;
  siteName: string;
  hostname: string;
  accessMode: string;
  hasLogo: boolean;
  /** The resource's tile, as the admin console shows it. */
  tile: { icon: string; color: IconColor; logoUrl: string | null; logoBg: string | null };
  siteId: string;
  glyph: string;
  status: "active" | "upcoming" | "off_hours" | "pending";
  href: string;
  /** The .rdp download when the resource also opens in the user's own Remote Desktop app. */
  rdpHref: string | null;
  /** Where to get a command for the user's own SSH client, when the resource allows one. */
  sshHref: string | null;
  /** Its browser sessions are recorded (native RDP and SSH are when rdpRecorded / sshRecorded). */
  recorded?: boolean;
  /** The user's own SSH client is recorded too (connector/sshproxy.go). */
  sshRecorded?: boolean;
  rdpRecorded?: boolean;
  /** Needs a moderator: a session starts once one admits it (lib/moderation). */
  moderated?: boolean;
  /** Where to get the ssh command of a TCP tunnel resource, when it opens now. */
  tunnelHref?: string | null;
  /** Where to get connection details for the user's own database client (a DATABASE resource). */
  dbHref?: string | null;
  time: Remaining;
  whenIso?: string | null; // upcoming cards only: start instant (rendered in the display timezone); null = "Scheduled"
}
export interface RecentVM { id: string; name: string; protocol: string; durationText: string; }

const STATUS_ICON: Record<StatusLine["tone"], { icon: "key" | "video" | "shield"; tone: string }> = {
  good: { icon: "key", tone: "ok" },
  info: { icon: "video", tone: "bad" },
  muted: { icon: "shield", tone: "muted" },
};

/** My access, as the design hand-off lays it out: the person's resources on the
 *  left, security status, scheduled access and recent sessions on the right. */
export function PortalHome(props: {
  firstName: string; activeCount: number; anyRecorded: boolean; allRecorded: boolean;
  cards: CardVM[]; upcoming: CardVM[]; recent: RecentVM[]; security: StatusLine[];
  requireJustification: boolean;
}) {
  const { firstName, activeCount, anyRecorded, allRecorded, cards, upcoming, recent, security, requireJustification } = props;
  return (
    <>
      <div className="page-head">
        <div>
          {anyRecorded && <div className="eyebrow"><span className="rec-dot" aria-hidden="true" /> {allRecorded ? "All sessions in this workspace are recorded" : "Some of your sessions are recorded"}</div>}
          <h1>Welcome back, {firstName}</h1>
          <p>{activeCount} active grant{activeCount === 1 ? "" : "s"} · in the browser, no VPN</p>
        </div>
        <RequestAccessButton requireJustification={requireJustification} />
      </div>

      <div className="ma-grid">
        <AccessCards cards={cards} />

        <div className="ma-rail">
          <section className="card">
            <div className="card-head"><h2>Security status</h2></div>
            <div className="ma-status">
              {security.map((s, i) => (
                <div key={i} className="ma-status-row">
                  <span className={`ma-status-ic ${STATUS_ICON[s.tone].tone}`}><NavIcon name={STATUS_ICON[s.tone].icon} size={15} /></span>
                  {s.label}
                </div>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Scheduled access</h2><span className="count">{upcoming.length}</span></div>
            {upcoming.length === 0 ? (
              <Empty icon="clock" title="Nothing scheduled" text="Access that starts later shows up here." />
            ) : (
              <div className="cx-rows">
                {upcoming.map((u) => (
                  <div key={u.id} className="ma-up"><b>{u.siteName}</b><span className="mono t-muted">{u.whenIso ? <LocalTime iso={u.whenIso} mode="short" /> : "Scheduled"}</span></div>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-head"><h2>Recent sessions</h2></div>
            {recent.length === 0 ? (
              <Empty icon="activity" title="No sessions yet" text="Your last sessions are listed here." />
            ) : (
              <div className="cx-rows">
                {recent.map((r) => (
                  <div key={r.id} className="ma-up"><b>{r.name}</b><span className="mono t-muted">{r.protocol ? `${r.protocol === "mssql" ? "SQL SERVER" : r.protocol.toUpperCase()} · ` : ""}{r.durationText}</span></div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
