import Link from "next/link";
import type { ConsoleData } from "@/lib/console/data";
import { duration, expiresIn, activeAgo } from "@/lib/console/format";
import { RevokeAccessButton } from "./revoke-access-button";
import { DecisionButtons } from "@/app/(app)/admin/grants/decision-buttons";
import { TerminateButton } from "./terminate-button";
import { ExtendButton } from "./extend-button";
import { AutoRefresh } from "@/app/(app)/_shell/auto-refresh";
import { LocalTime } from "@/app/(app)/_shell/local-time";

export function SecurityConsole({ data }: { data: ConsoleData }) {
  const now = new Date();
  const { kpis, live, pending, expiring, connectors, audit } = data;
  const cells: { label: string; value: number; tone: string }[] = [
    { label: "GRANTS", value: kpis.grants, tone: "" },
    { label: "LIVE", value: kpis.live, tone: "accent" },
    { label: "PENDING", value: kpis.pending, tone: "warn" },
    { label: "EXPIRING 24H", value: kpis.expiring24h, tone: "danger" },
    { label: "RECORDINGS 7D", value: kpis.recordings7d, tone: "" },
  ];

  return (
    <div className="sc">
      <AutoRefresh />
      <div className="sc-kpis">
        {cells.map((c) => (
          <div key={c.label} className="sc-kpi">
            <div className="sc-kpi-label">{c.label}</div>
            <div className={`sc-kpi-value${c.tone ? " " + c.tone : ""}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <section className="sc-block">
        <div className="sc-head"><h2>Live sessions</h2><Link href="/admin/live" className="sc-more">All sessions →</Link></div>
        {live.length === 0 ? (
          <div className="sc-empty">No live sessions.</div>
        ) : (
          <div className="sc-live">
            {live.map((s) =>
              s.kind === "gateway" ? (
                <div key={s.sessionId} className="sc-card">
                  <div className="sc-card-top">
                    <span className="sc-chip">{s.protocol.toUpperCase()}</span>
                    {s.recorded && <span className="sc-rec"><span className="sc-dot" />REC {duration(s.startedAt, now)}</span>}
                  </div>
                  <div className="sc-card-name">{s.host}</div>
                  <div className="sc-card-sub">{s.userLabel}{s.viewerCount > 0 ? ` · ${s.viewerCount} watching` : ""}</div>
                  <div className="sc-thumb">live session</div>
                  <div className="sc-card-actions">
                    <Link href={`/live/${s.sessionId}`} className="sc-btn watch">Watch live</Link>
                    <TerminateButton sessionId={s.sessionId} grantId={s.grantId} vendorLabel={s.userLabel} className="sc-btn danger" />
                  </div>
                </div>
              ) : s.kind === "isolated" ? (
                <div key={s.sessionId} className="sc-card">
                  <div className="sc-card-top">
                    <span className="sc-chip">ISOLATED</span>
                    {s.recorded && <span className="sc-rec"><span className="sc-dot" />REC {duration(s.startedAt, now)}</span>}
                  </div>
                  <div className="sc-card-name">{s.host}</div>
                  <div className="sc-card-sub">{s.userLabel}{s.viewerCount > 0 ? ` · ${s.viewerCount} watching` : ""}</div>
                  <div className="sc-thumb">isolated browser</div>
                  <div className="sc-card-actions">
                    <Link href={`/live/${s.sessionId}`} className="sc-btn watch">Watch live</Link>
                    <TerminateButton sessionId={s.sessionId} grantId={s.grantId} vendorLabel={s.userLabel} className="sc-btn danger" />
                  </div>
                </div>
              ) : (
                <div key={`web:${s.userLabel}:${s.siteName}:${s.host}`} className="sc-card">
                  <div className="sc-card-top">
                    <span className="sc-chip">WEB APP</span>
                    <span className="sc-meta">active {activeAgo(s.lastSeen, now)}</span>
                  </div>
                  <div className="sc-card-name">{s.siteName}</div>
                  <div className="sc-card-sub">{s.userLabel} · {s.host}{s.viewerCount > 0 ? ` · ${s.viewerCount} watching` : ""}</div>
                  <div className="sc-thumb">web session</div>
                  <div className="sc-card-actions">
                    {s.liveKey && <Link href={`/live/web/${encodeURIComponent(s.liveKey)}`} className="sc-btn watch">Watch live</Link>}
                    {s.grantId ? (
                      <RevokeAccessButton grantId={s.grantId} label={s.userLabel} className="sc-btn danger" />
                    ) : (
                      <span className="sc-meta">No active grant</span>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </section>

      <div className="sc-grid">
        <div className="sc-panel">
          <div className="sc-head"><h2>Pending requests</h2>{pending.length > 0 && <span className="sc-count">{pending.length}</span>}</div>
          {pending.length === 0 ? <div className="sc-empty">Nothing waiting.</div> : pending.map((p) => (
            <div key={p.id} className="sc-req">
              <div className="sc-req-t">{p.userLabel} → {p.siteName}</div>
              {p.detail && <div className="sc-req-d">{p.detail}</div>}
              <DecisionButtons grantId={p.id} />
            </div>
          ))}
        </div>

        <div className="sc-col">
          <div className="sc-panel">
            <div className="sc-head"><h2>Expiring soon</h2></div>
            {expiring.length === 0 ? <div className="sc-empty">Nothing expiring.</div> : expiring.map((e) => (
              <div key={e.id} className="sc-exp">
                <Link href="/admin/grants" className="sc-exp-t">{e.userLabel} → {e.siteName}</Link>
                <span className="sc-exp-left">{expiresIn(e.endsAt, now)}</span>
                <ExtendButton grantId={e.id} endsAt={e.endsAt} />
              </div>
            ))}
          </div>
          <div className="sc-panel">
            <div className="sc-head"><h2>Connectors</h2></div>
            {connectors.length === 0 ? <div className="sc-empty">No connectors.</div> : connectors.map((c) => (
              <div key={c.id} className="sc-conn">
                <span className={`sc-dot ${c.online ? "ok" : "down"}`} />
                <span className="sc-conn-name">{c.name}</span>
                <span className="sc-conn-state">{c.online ? "online" : "offline"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="sc-panel">
          <div className="sc-head"><h2>Audit stream</h2></div>
          {audit.length === 0 ? <div className="sc-empty">No recent activity.</div> : audit.map((r) => (
            <div key={r.id} className="sc-audit">
              <span className="sc-audit-t"><LocalTime iso={new Date(r.at).toISOString()} mode="time" /></span>
              <span className={`sc-audit-k ${r.tone}`}>{r.kind}</span>
              <span className="sc-audit-m">{r.text}</span>
            </div>
          ))}
          <div className="sc-morefoot"><Link href="/admin/audit" className="sc-more">Full audit log →</Link></div>
        </div>
      </div>
    </div>
  );
}
