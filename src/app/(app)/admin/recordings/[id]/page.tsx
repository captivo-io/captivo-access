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
        {rec.format === "GUAC"
          ? <GuacRecordingPlayer recordingId={rec.id} />
          : rec.format === "VIDEO"
          ? <VideoRecordingPlayer id={rec.id} />
          : <RecordingPlayer id={rec.id} />}
      </div>
    </main>
  );
}

export default async function RecordingPage(...args: Parameters<typeof RecordingPageImpl>) {
  return withRequestTenant(() => RecordingPageImpl(...args));
}

