// The last release that changed what runs on a connector host: the connector,
// the tunnel protocol it speaks, and the updater, guacd and isolated-browser
// images beside it. A connector older than this is outdated; one at it or
// newer is current even when the console is newer, because a console-only
// release has nothing new for the connector.
//
// Raise it to the release's version whenever that release changes one of
// CONNECTOR_PATHS. scripts/check-connector-release.sh fails the tag's publish
// run when it was not raised.
export const CONNECTOR_RELEASE = "2.46.0";

export const CONNECTOR_PATHS = ["connector", "tunnel", "updater", "guacd", "kasm-browser"] as const;
