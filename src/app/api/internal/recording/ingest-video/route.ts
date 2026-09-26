import { NextRequest, NextResponse } from "next/server";

/**
 * Gone: recording bytes are no longer accepted by the control plane.
 *
 * Since connector-local recordings, the dataplane writes every chunk into the
 * customer's own connector (dataplane/recclient.go) and reports only the index to
 * /api/internal/recording/ingest. Nothing calls this route.
 *
 * It answers 410 instead of being deleted so that a stale dataplane -- the few
 * seconds of a rolling deploy, or an operator running mismatched images -- gets a
 * clear refusal in the log rather than a 404 that reads like a routing bug. And it
 * refuses rather than storing: losing seconds of recording in a deploy window is
 * acceptable, quietly keeping a central copy of a customer's screen content is not.
 *
 * Safe to delete once no supported dataplane version posts here.
 */
export async function POST(req: NextRequest) {
  console.warn(
    `[recording] ${new URL(req.url).pathname} was called: a dataplane is still posting recording bytes centrally. Upgrade it -- these bytes belong on the connector.`
  );
  return NextResponse.json(
    { error: "gone", detail: "recording bytes are stored on the connector; report the index to /api/internal/recording/ingest" },
    { status: 410 }
  );
}
