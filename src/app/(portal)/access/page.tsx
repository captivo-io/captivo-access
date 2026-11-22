import { requireUser } from "@/lib/current-user";
import { newestVersion } from "@/lib/connector/route";
import { db } from "@/lib/db";
import { listUserGrants } from "@/lib/access/grants";
import { siteTile } from "@/lib/access/grant-rows";
import { classifyGrant } from "@/lib/access/evaluate";
import { recordingEnabled } from "@/lib/recording/enabled";
import { effectiveRecordSessions } from "@/lib/recording/mode";
import { listRecordings } from "@/lib/recording/query";
import { remaining } from "@/lib/portal/time-remaining";
import { securityStatus } from "@/lib/portal/security-status";
import { launchHref } from "@/lib/portal/launch-href";
import { nativeRdpBlock } from "@/lib/gateway/native-rdp";
import { nativeSshBlock } from "@/lib/gateway/native-ssh";
import { databaseBlock } from "@/lib/database/params";
import { resolvedRequireRequestJustification, resolvedRecordingMode } from "@/lib/settings/platform";
import { PortalHome, type CardVM, type RecentVM } from "./portal-home";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "My access" };

async function AccessPageImpl() {
  const user = await requireUser();
  const now = new Date();
  const recEnabled = recordingEnabled();
  // Resolve the tenant recording policy once (this grants list is a single tenant) so the
  // vendor-facing "sessions are recorded" claim honors required/off, not the raw toggle.
  const recMode = await resolvedRecordingMode();

  const [grants, passkeyCount, recentRes] = await Promise.all([
    listUserGrants(user.id),
    db.passkey.count({ where: { userId: user.id } }),
    listRecordings({ userId: user.id, limit: 3, offset: 0 }),
  ]);

  const cards: CardVM[] = [];
  const upcoming: CardVM[] = [];
  const siteName = new Map<string, string>();
  let anyRecorded = false;
  // "All sessions are recorded" only while it is true: an unrecorded resource,
  // or one that also opens in the user's own app (never recorded), makes it "some".
  const required = recEnabled && recMode === "required";
  let allRecorded = true;

  for (const g of grants) {
    const reason = classifyGrant(g, now);
    let status: CardVM["status"] | null = null;
    if (reason === "allow") status = "active";
    else if (reason === "not_yet") status = "upcoming";
    else if (reason === "off_schedule") status = "off_hours";
    else if (reason === "pending_approval") status = "pending";
    // Denied is intentionally NOT shown to the vendor (same as expired/revoked):
    // a denied card leaks the existence of resources they can't reach and surfaces
    // the admin's internal denial note. Pending requests still show as "pending".
    if (!status) continue; // expired / revoked / denied not shown

    siteName.set(g.site.id, g.site.name);
    const recorded = recEnabled && effectiveRecordSessions(recMode, g.site.recordSessions);
    if (recorded) anyRecorded = true;
    else allRecorded = false;

    const startISO = g.startsAt ? g.startsAt.toISOString() : null;
    const endISO = g.endsAt ? g.endsAt.toISOString() : null;
    const card: CardVM = {
      id: g.id,
      siteName: g.site.name,
      hostname: g.site.hostname ?? "",
      accessMode: g.site.accessMode,
      hasLogo: g.site.logoType != null,
      tile: (({ icon, color, logoUrl, logoBg }) => ({ icon, color, logoUrl, logoBg }))(siteTile(g.site)),
      siteId: g.site.id,
      glyph: g.site.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "··",
      status,
      href: launchHref(g.site.accessMode, g.site.id, g.site.hostname ?? ""),
      rdpHref: nativeRdpBlock({ accessMode: g.site.accessMode, nativeRdp: g.site.nativeRdp, protocol: g.site.vaultCredential?.protocol, recordingRequired: required, connectorVersion: newestVersion(g.site) }) === null
        ? `/api/portal/rdp/${g.site.id}` : null,
      sshHref: nativeSshBlock({ accessMode: g.site.accessMode, nativeSsh: g.site.nativeSsh, protocol: g.site.vaultCredential?.protocol, recordingRequired: required, connectorVersion: newestVersion(g.site) }) === null
        ? `/api/portal/ssh/${g.site.id}` : null,
      dbHref: databaseBlock({ accessMode: g.site.accessMode, connectorVersion: newestVersion(g.site) }) === null ? `/api/portal/db/${g.site.id}` : null,
      recorded,
      time: remaining(startISO, endISO, g.schedule ?? null, now),
    };
    if (status === "upcoming") {
      card.whenIso = startISO;
      upcoming.push(card);
    } else cards.push(card);
  }

  const recent: RecentVM[] = recentRes.rows.map((r) => ({
    id: r.id,
    name: siteName.get(r.siteId) ?? r.host,
    protocol: r.protocol ?? "",
    durationText: durationText(r.startedAt, r.lastEventAt),
  }));

  const security = securityStatus({ hasPasskey: passkeyCount > 0, anyRecorded });
  const activeCount = cards.filter((c) => c.status === "active").length;

  const requireJustification = await resolvedRequireRequestJustification();

  return (
    <PortalHome
      firstName={(user.name ?? "").split(" ")[0] || "there"}
      activeCount={activeCount}
      anyRecorded={anyRecorded}
      allRecorded={allRecorded && !cards.some((c) => c.rdpHref || c.sshHref)}
      cards={cards}
      upcoming={upcoming}
      recent={recent}
      security={security}
      requireJustification={requireJustification}
    />
  );
}

export default async function AccessPage(...args: Parameters<typeof AccessPageImpl>) {
  return withRequestTenant(() => AccessPageImpl(...args));
}

function durationText(start: Date, end: Date): string {
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}h ${m}m`;
}
