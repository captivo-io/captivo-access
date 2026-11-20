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
};

// Words after the code that are themselves codes (dataplane/rdpgw.go writes
// "session_open native_rdp").
const REASON_DETAILS: Record<string, string> = {
  native_rdp: "own RDP app",
};

export function accessReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
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
