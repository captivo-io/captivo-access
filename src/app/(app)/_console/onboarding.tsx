import Link from "next/link";
import type { OnboardingView } from "@/lib/console/onboarding";
import { DismissSetup } from "./dismiss-setup";

// Console for a new workspace (design hand-off 7.25). Steps come from data
// (lib/console/onboarding.ts), never from clicking their buttons.

const GUIDE_URL = "https://captivo.io/en/docs/access-cloud";
const SUPPORT = "support@captivo.io";

const ICON = {
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><path d="M9 12l2 2 4-4" /></>,
  plug: <><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0V8z" /><path d="M12 16v5" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  key: <><circle cx="8" cy="14" r="4" /><path d="M11 11l8-8M16 3h4v4M13 8l2 2" /></>,
};

function Icon({ d }: { d: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
}

const STEPS = [
  {
    title: "Connect your network",
    text: "Run a connector inside your network. It opens an encrypted, outbound-only tunnel to Captivo, with no inbound ports.",
    time: "~5 MIN", cta: "Add connector", view: "View connector", href: "/admin/connectors#cn-install", viewHref: "/admin/connectors",
    points: ["Docker, Linux or Windows", "One-command install", "No inbound ports"], icon: ICON.plug,
  },
  {
    title: "Add your first internal app",
    text: "Define an app the connector can reach as a resource: web app, isolated browser, remote desktop or SSH.",
    time: "~2 MIN", cta: "Add resource", view: "View resources", href: "/admin/sites?new=1", viewHref: "/admin/sites",
    points: ["Enter the internal address", "Try the connection", "Pick recording and clipboard rules"], icon: ICON.server,
  },
  {
    title: "Grant someone access",
    text: "Tie a user or vendor to the resource; optionally time-boxed, approved or scheduled.",
    time: "~1 MIN", cta: "Grant access", view: "View grants", href: "/admin/grants?new=1", viewHref: "/admin/grants",
    points: ["Pick a user or vendor", "Set a window", "An invite email is sent"], icon: ICON.key,
  },
];

export function Onboarding({ view, host }: { view: OnboardingView; host: string }) {
  const [connector, app, grant] = view.done;
  // User lights up once someone can reach the app; Edge is always on.
  const nodes = [
    { title: "User", sub: "browser", icon: ICON.globe, tone: "ink", on: grant },
    { title: "Captivo Edge", sub: host, icon: ICON.shield, tone: "p", on: true },
    { title: "Connector", sub: "inside your network", icon: ICON.plug, tone: "ok", on: connector },
    { title: "Internal app", sub: "web · RDP · SSH", icon: ICON.server, tone: "a", on: app },
  ];
  return (
    <div className="ob">
      <section className="ob-card" aria-labelledby="ob-title">
        <div className="ob-head">
          <div>
            <h2 id="ob-title">Get set up</h2>
            <p>About 10 minutes in total. Do the steps in any order.</p>
          </div>
          <div className="ob-progress">
            <span className="ob-count">{view.count} / 3 done</span>
            <span className="ob-bar" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={3} aria-valuenow={view.count}>
              <span style={{ width: `${Math.round((view.count / 3) * 100)}%` }} />
            </span>
          </div>
        </div>

        <div className="ob-diagram">
          <div className="ob-nodes">
            {nodes.map((n, i) => (
              <div key={n.title} className="ob-node-wrap">
                <div className={`ob-node${n.on ? ` on ${n.tone}` : ""}`}>
                  <span className="ob-node-ic">
                    <Icon d={n.icon} />
                    {n.on && <span className="ob-node-dot" aria-hidden="true" />}
                  </span>
                  <span className="ob-node-t">{n.title}</span>
                  <span className="ob-node-s">{n.sub}</span>
                  <span className="sr-only">{n.on ? "ready" : "not set up yet"}</span>
                </div>
                {i < nodes.length - 1 && <span className={`ob-link${n.on && nodes[i + 1].on ? " flow" : ""}`} aria-hidden="true" />}
              </div>
            ))}
          </div>
          <p className="ob-caption">The user connects from the browser → Captivo Edge checks identity and access → the connector forwards the request to the app from inside your network.</p>
        </div>

        {STEPS.map((s, i) => {
          const done = view.done[i];
          const cur = i === view.current;
          const state = done ? "done" : cur ? "cur" : "later";
          return (
            <div key={s.title} className={`ob-step ${state}`}>
              <span className="ob-num" aria-hidden="true">{done ? "✓" : i + 1}</span>
              <span className="ob-tile" aria-hidden="true"><Icon d={s.icon} /></span>
              <div className="ob-body">
                <div className="ob-title">
                  <h3>{s.title}</h3>
                  <span className="ob-chip">{done ? "DONE" : cur ? `NEXT · ${s.time}` : s.time}</span>
                </div>
                <p>{s.text}</p>
                {cur && (
                  <ul className="ob-points">
                    {s.points.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                )}
              </div>
              <div className="ob-act">
                {done ? (
                  <Link className="ob-view" href={s.viewHref}>{s.view} →</Link>
                ) : (
                  <Link className={cur ? "btn primary" : "btn"} href={s.href}>{s.cta}{cur ? " →" : ""}</Link>
                )}
              </div>
            </div>
          );
        })}

        {view.complete && (
          <div className="ob-complete" role="status">
            <span className="ob-complete-ic" aria-hidden="true">✓</span>
            <div>
              <strong>Setup complete</strong>
              <p>Your first user can now reach the app from the browser. From here the console shows live sessions and health.</p>
            </div>
            <DismissSetup variant="finish" />
          </div>
        )}
      </section>

      <div className="ob-foot">
        <span>
          <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer">Setup guide ↗</a>
          <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
        </span>
        {!view.complete && <DismissSetup variant="skip" />}
      </div>
    </div>
  );
}
