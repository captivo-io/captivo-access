import { NextRequest, NextResponse } from "next/server";

/**
 * Gone: keystroke events are no longer accepted by the control plane.
 *
 * They are the most sensitive thing this product records -- literally what the
 * vendor typed -- and they now live in the customer's own connector store as "keys"
 * chunks, written by the dataplane (dataplane/keywriter.go) and searched there
 * (connector/recsearch.go). Nothing calls this route.
 *
 * It answers 410 rather than being deleted so a stale dataplane gets a clear
 * refusal in the log instead of a 404 that reads like a routing bug -- and it
 * refuses rather than storing. Losing a session's keystroke log in a deploy window
 * is acceptable; quietly keeping a central copy of what someone typed is not.
 *
 * Safe to delete once no supported dataplane version posts here.
 */
export async function POST(req: NextRequest) {
  console.warn(
    `[recording] ${new URL(req.url).pathname} was called: a dataplane is still posting keystroke events centrally. Upgrade it -- this text belongs on the connector.`
  );
  return NextResponse.json(
    { error: "gone", detail: "keystroke events are stored on the connector" },
    { status: 410 }
  );
}
