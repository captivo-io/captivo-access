// Where the "Open" button on an access card points. GATEWAY and ISOLATED
// resources open the in-Captivo native session page (screen stream); web
// (TRANSPARENT) resources open directly.
// A DATABASE resource has no page to open: its card offers connection details
// for the user's own client instead (dbHref); a TUNNEL one an ssh command (sshHref).
export function launchHref(accessMode: string, siteId: string, hostname: string): string {
  if (accessMode === "DATABASE" || accessMode === "TUNNEL") return "";
  return accessMode === "GATEWAY" || accessMode === "ISOLATED" ? `/gateway/${siteId}/session` : `https://${hostname}`;
}
