// The four verbs stored in AuditEvent.method for gateway file transfers. Single
// source of truth on the TS side; the Go side mirrors these in
// dataplane/guacfiletransfer.go. Keep the two in sync.
export const TRANSFER_VERBS = ["DOWNLOAD", "UPLOAD", "DOWNLOAD-PARTIAL", "UPLOAD-PARTIAL"] as const;

export type TransferBadge = {
  isTransfer: boolean;
  direction?: "download" | "upload";
  partial?: boolean;
  label?: string;
};

// Maps an AuditEvent.method to a badge descriptor. Non-transfer methods (real
// HTTP verbs from the browser proxy) return { isTransfer: false }.
export function transferBadge(method: string): TransferBadge {
  switch (method) {
    case "DOWNLOAD":
      return { isTransfer: true, direction: "download", partial: false, label: "Download" };
    case "UPLOAD":
      return { isTransfer: true, direction: "upload", partial: false, label: "Upload" };
    case "DOWNLOAD-PARTIAL":
      return { isTransfer: true, direction: "download", partial: true, label: "Download (partial)" };
    case "UPLOAD-PARTIAL":
      return { isTransfer: true, direction: "upload", partial: true, label: "Upload (partial)" };
    default:
      return { isTransfer: false };
  }
}

// AuditEvent.reason in words for the console. The deny codes are the access
// check's (src/lib/access/evaluate.ts, the IP allowlist); session_close may
// carry the session's length after a space. Unknown codes are shown as stored.
const REASONS: Record<string, string> = {
  allow: "Grant active",
  session_open: "Session opened",
  session_close: "Session closed",
  replay: "Loaded by a recording replay",
  no_grant: "No grant for this resource",
  user_disabled: "Account disabled",
  revoked: "Grant revoked",
  denied: "Grant request was denied",
  not_yet: "Grant has not started yet",
  expired: "Grant expired",
  off_schedule: "Outside the grant's hours",
  pending_approval: "Grant waiting for approval",
  ip_not_allowed: "Network not on the IP allowlist",
  database_not_allowed: "Database not open on this resource",
  session_end_policy: "Session ended by policy",
  // A recorded native SSH session's refusals (dataplane/sshrec.go).
  port_forward: "Port forwarding refused (recorded session)",
  sftp_off: "File transfer is off",
  transfer_off: "File transfer is off",
  host_key_changed: "The server's SSH host key changed",
  sign_in_failed: "Signing in to the server failed",
  connector_outdated: "The connector needs an update",
  // Kubernetes requests (dataplane/kubeproxy.go): what was refused or opened follows.
  kubernetes_refused: "Refused by the resource's rules",
  kubernetes_portforward: "Port forward",
  kubernetes_proxy: "Proxy to a pod or service",
};

// Words after the code that are themselves codes (dataplane/rdpgw.go writes
// "session_open native_rdp", dataplane/sshjump.go "session_open native_ssh").
const REASON_DETAILS: Record<string, string> = {
  native_rdp: "own RDP app",
  native_ssh: "own SSH app",
  native_ssh_recorded: "own SSH app, recorded",
  native_tcp: "TCP tunnel",
  database: "own database client",
  kubernetes: "own kubectl",
  kubernetes_exec: "kubectl exec",
  kubernetes_attach: "kubectl attach",
  grant_ended: "grant ended",
  ticket_ended: "connection ticket ended",
  grant_inactive: "grant no longer active",
};

export function accessReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  // A native client's refusal carries the check's code after the client
  // (dataplane/rdpgw.go "native_rdp_no_grant", sshjump.go "native_ssh_expired").
  const native = /^(native_rdp|native_ssh|native_tcp)_(.+)$/.exec(reason.trim());
  if (native) {
    const sftp = /^sftp_(\w+)_off$/.exec(native[2]);
    const why = native[2] === "not_allowed" ? "Not allowed in the user's own app"
      : sftp ? `SFTP ${sftp[1]} refused (file transfer rule)`
      : REASONS[native[2]] ?? native[2];
    return `${why} · ${REASON_DETAILS[native[1]]}`;
  }
  const [code, ...rest] = reason.trim().split(/\s+/);
  const label = REASONS[code];
  if (!label) return reason;
  return rest.length ? `${label} · ${rest.map((w) => REASON_DETAILS[w] ?? w).join(" ")}` : label;
}

// A native RDP client's session (dataplane/rdpgw.go) is stored under the RD
// Gateway request that carried it, not an HTTP verb a reader would know.
export function isNativeRdpMethod(method: string): boolean {
  return method === "RDG_OUT_DATA" || method === "RDG_IN_DATA";
}

// A session through the SSH jump host (dataplane/sshjump.go) is stored under
// this method: there is no HTTP request behind it.
export function isNativeSshMethod(method: string): boolean {
  return method === "SSH";
}

// A Kubernetes session through the proxy (dataplane/kubeproxy.go); its path is
// the namespace ("/web") when the event has one.
export function isKubernetesMethod(method: string): boolean {
  return method === "K8S";
}

// A database session through the proxy (dataplane/pgproxy.go); its path is
// the database ("/crm").
export function isDatabaseMethod(method: string): boolean {
  return method === "DB";
}
