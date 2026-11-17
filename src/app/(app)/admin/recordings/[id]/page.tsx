import { requireAdmin } from "@/lib/current-user";
import { db } from "@/lib/db";
import Link from "next/link";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { RecordingPlayer } from "./recording-player";
import { GuacRecordingPlayer } from "./guac-recording-player";
import { VideoRecordingPlayer } from "./video-recording-player";
import { withRequestTenant } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recording" };

async function RecordingPageImpl({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const rec = await db.sessionRecording.findUnique({ where: { id } });
  if (!rec) {
    return <main><div className="empty">Recording not found.</div></main>;
  }
  const user = await db.user.findUnique({ where: { id: rec.userId }, select: { name: true, email: true } });
  const site = await db.site.findUnique({ where: { id: rec.siteId }, select: { name: true } });
  const estimatedMs = rec.lastEventAt ? Math.max(0, rec.lastEventAt.getTime() - rec.startedAt.getTime()) : 0;
  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Recording</h1>
          <p>{user?.name ?? "—"} · {site?.name ?? rec.host} · <LocalTime iso={rec.startedAt.toISOString()} /></p>
        </div>
        <Link href="/admin/recordings" className="btn sm">Back to recordings</Link>
      </div>
      {rec.truncated ? (
        <div className="warn" role="status">
          This recording is incomplete. Capture stopped when it reached the size limit set on the
          data plane (<code>RECORDING_MAX_BYTES</code>) while the session continued, so the replay
          ends before the session did. What was captured up to that point plays normally.
        </div>
      ) : null}
      <div className="card">
        {/* An RDP/VNC recording plays as video once its connector has made one
            (videoReady); until then, and for SSH, the instruction stream plays. */}
        {rec.format === "VIDEO" || (rec.format === "GUAC" && rec.videoReady)
          ? <VideoRecordingPlayer id={rec.id} durationMs={rec.durationMs ?? estimatedMs} />
          : rec.format === "GUAC"
          ? <GuacRecordingPlayer recordingId={rec.id} estimatedMs={rec.durationMs ?? estimatedMs} />
          : <RecordingPlayer id={rec.id} />}
      </div>
    </main>
  );
}

export default async function RecordingPage(...args: Parameters<typeof RecordingPageImpl>) {
  return withRequestTenant(() => RecordingPageImpl(...args));
}

