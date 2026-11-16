// Why a live session was closed by the periodic access recheck
// (dataplane/recheck.go), in words for the vendor. The reasons are the access
// check's (src/lib/access/evaluate.ts, the IP allowlist) plus "signed_out".
export function sessionEndMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "Your access to this resource has expired.";
    case "off_schedule":
      return "Your access hours for this resource are over for now.";
    case "revoked":
    case "denied":
    case "no_grant":
      return "Your access to this resource was withdrawn.";
    case "pending_approval":
    case "not_yet":
      return "Your access to this resource is not active right now.";
    case "user_disabled":
      return "Your account has been disabled.";
    case "ip_not_allowed":
      return "You are connecting from a network that is not allowed for this resource.";
    case "signed_out":
      return "You were signed out: your sign-in expired or was ended.";
    default:
      return "Access to this resource is no longer allowed.";
  }
}
