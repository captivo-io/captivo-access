import Link from "next/link";
import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import { videoPreparing } from "@/lib/recording/preparing";
import { TRANSFER_VERBS, transferBadge } from "@/lib/audit/access-format";
import { resolvedRecordingRetentionDays } from "@/lib/settings/platform";
import { workspaceView } from "@/lib/mobile/views";
import { withRequestTenant } from "@/lib/tenant/request";
import { humanBytes } from "@/lib/recording/format";
import { RecordingView } from "./recording-view";
import { guestsOfRecording } from "@/lib/live/invites";
import { connectorForRecording } from "@/lib/recording/connector-of";
import { silentFor } from "@/lib/recording/unreachable";
import { holderNotice } from "@/lib/recording/holder-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recording" };

async function RecordingPageImpl({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const { t } = await searchParams;
  const rec = await db.sessionRecording.findUnique({ where: { id } });
  if (!rec) {
    return (
      <main>
        <Link href="/admin/recordings" className="btn sm rc-back">← Recordings</Link>
        <div className="au-empty" style={{ marginTop: 16 }}><b>Recording not found</b><span className="cell-sub">It may have been erased, or the link is for another workspace.</span></div>
      </main>
    );
  }
  const estimatedMs = rec.lastEventAt ? Math.max(0, rec.lastEventAt.getTime() - rec.startedAt.getTime()) : 0;
  const lengthMs = rec.durationMs ?? estimatedMs;
  const [ws, user, site, retention, transfers, carrier, guests, copyRows] = await Promise.all([
    workspaceView().catch(() => ({ name: "", slug: null as string | null })),
    db.user.findUnique({ where: { id: rec.userId }, select: { name: true, email: true } }),
    db.site.findUnique({ where: { id: rec.siteId }, select: { name: true, connector: { select: { version: true } } } }),
    resolvedRecordingRetentionDays(),
    // Files moved during the session, from the audit log (same person, resource and span).
    db.auditEvent.findMany({
      where: {
        userId: rec.userId, siteId: rec.siteId, method: { in: [...TRANSFER_VERBS] },
        timestamp: { gte: rec.startedAt, lte: new Date(rec.startedAt.getTime() + lengthMs + 5000) },
      },
      orderBy: { timestamp: "asc" },
      take: 200,
      select: { timestamp: true, method: true, path: true, bytesOut: true },
    }),
    // The connector that keeps its recording: the one that carried the session, or,
    // for an older recording of a deleted resource, the one found holding it.
    connectorForRecording(rec).then((cid) => (cid ? db.connector.findUnique({ where: { id: cid }, select: { name: true, status: true, lastSeenAt: true } }) : null)),
    // People invited into the session from outside while it ran.
    guestsOfRecording({ siteId: rec.siteId, userId: rec.userId, startedAt: rec.startedAt, endedAt: new Date(rec.startedAt.getTime() + lengthMs) }).catch(() => []),
    // Copies on other members of the connector group that carried the session.
    db.recordingReplica.findMany({
      where: { recordingId: rec.id },
      orderBy: { createdAt: "asc" },
      select: { state: true, connector: { select: { name: true, status: true, lastSeenAt: true } } },
    }),
  ]);
  const copies = copyRows.map((c) => ({ name: c.connector.name, online: c.connector.status === "ONLINE", lastSeenAt: c.connector.lastSeenAt, complete: c.state === "COMPLETE" }));
  const where = holderNotice(
    { format: rec.format, videoReady: rec.videoReady, protocol: rec.protocol },
    carrier ? { name: carrier.name, online: carrier.status === "ONLINE", lastSeenAt: carrier.lastSeenAt } : null,
    copies,
    new Date(),
  );
  const startSec = Number(t);
  const view = {
    id: rec.id,
    format: rec.format,
    protocol: rec.protocol,
    videoReady: rec.videoReady,
    preparing: videoPreparing(rec, site?.connector?.version),
    startedAt: rec.startedAt.toISOString(),
    lengthMs,
    measured: rec.durationMs !== null,
    bytes: rec.bytes,
    host: rec.host,
    connector: carrier?.name ?? null,
    copies: copyRows.map((c) => ({ name: c.connector.name, complete: c.state === "COMPLETE", online: c.connector.status === "ONLINE" })),
    guests,
    encrypted: rec.encrypted,
    purgePending: rec.purgePendingAt !== null,
  };
  const files = transfers.map((e) => {
    const b = transferBadge(e.method);
    const size = Number(e.bytesOut) > 0 ? ` · ${humanBytes(Number(e.bytesOut))}` : "";
    return { atMs: e.timestamp.getTime() - rec.startedAt.getTime(), text: `${b.direction === "download" ? "Downloaded" : "Uploaded"}${b.partial ? " (partly)" : ""} ${e.path}${size}` };
  });

  // Said before the replay, so it does not read as the session ending there.
  const notice = where.kind === "from_copy" ? (
        <div className="warn" role="status">
          The connector that carried this session, <b>{where.original}</b>, is offline (last seen {where.since}). This is playing from the
          {where.complete ? " copy" : " copy still being made"} on <b>{where.copy}</b>
          {where.complete ? "." : ": it plays as far as it got, and the rest follows when the original is back."}
        </div>
      ) : where.kind === "offline" ? (
        <div className="warn" role="status">
          This recording is kept on the connector <b>{where.original}</b>, which is offline (last seen {where.since}).
          {where.copiesElsewhere.length > 0
            ? ` A copy is on ${where.copiesElsewhere.join(", ")}, which is offline too.`
            : ""}{" "}
          Nothing is lost: it plays again as soon as {where.copiesElsewhere.length > 0 ? "one of them" : "that connector"} is back online.
        </div>
      ) : !carrier ? (
        <div className="warn" role="status">
          This recording can&apos;t be played: the resource it came from was deleted, and none of
          this workspace&apos;s online connectors holds it. If the connector that carried the session
          is offline, open the recording again once it is back.
        </div>
      ) : rec.truncated ? (
        <div className="warn" role="status">
          This recording is incomplete. Capture stopped when it reached the size limit set on the
          data plane (<code>RECORDING_MAX_BYTES</code>) while the session continued, so the replay
          ends before the session did. What was captured up to that point plays normally.
        </div>
      ) : null;

  return (
    <main>
      <RecordingView
        notice={notice}
        rec={view}
        user={{ name: user?.name ?? null, email: user?.email ?? null }}
        siteName={site?.name ?? rec.host}
        workspace={ws.slug ?? ws.name ?? ""}
        retentionDays={retention}
        transfers={files}
        startMs={Number.isFinite(startSec) && startSec > 0 ? startSec * 1000 : undefined}
      />
    </main>
  );
}

export default async function RecordingPage(...args: Parameters<typeof RecordingPageImpl>) {
  return withRequestTenant(() => RecordingPageImpl(...args));
}
