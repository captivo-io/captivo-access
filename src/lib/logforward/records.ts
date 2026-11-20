import { TRANSFER_VERBS, accessReasonLabel, isNativeRdpMethod, isNativeSshMethod } from "@/lib/audit/access-format";

// One audit record as a SIEM receives it, whichever log it came from. Pure:
// the pump reads the rows, these functions decide what they say.

export type LogCategory = "session" | "file" | "request" | "admin";

export type LogRecord = {
  source: "access" | "admin";
  seq: bigint;
  at: Date;
  category: LogCategory;
  /** A stable event id for the SIEM's rules: session.open, file.upload, access.deny, grant.create, … */
  action: string;
  /** The event in a few words, the same for every record of its kind. */
  name: string;
  outcome: "allow" | "deny";
  user: string | null;
  userName: string | null;
  company: string | null;
  resource: string | null;
  resourceId: string | null;
  host: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  bytes: number | null;
  reason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  target: string | null;
  /** One line a person can read. */
  message: string;
  hash: string;
};

export type AccessRow = {
  seq: bigint; timestamp: Date; userEmail: string | null; userName: string | null; company: string | null;
  siteId: string | null; siteName: string | null; host: string; method: string; path: string; status: number;
  bytesOut: bigint; decision: "ALLOW" | "DENY"; reason: string | null; clientIp: string | null; userAgent: string | null; hash: string;
};

export type AdminRow = {
  seq: bigint | null; timestamp: Date; actorEmail: string | null; action: string; targetType: string | null;
  targetId: string | null; summary: string; clientIp: string | null; hash: string;
};

/** What the destination asked for. A denial is sent when either its own switch or its kind's is on. */
export type LogSelection = {
  sendSessions: boolean; sendFiles: boolean; sendDenied: boolean; sendAdmin: boolean; sendRequests: boolean;
};

export function wanted(sel: LogSelection, r: LogRecord): boolean {
  if (r.outcome === "deny" && sel.sendDenied) return true;
  switch (r.category) {
    case "session": return sel.sendSessions;
    case "file": return sel.sendFiles;
    case "admin": return sel.sendAdmin;
    case "request": return sel.sendRequests;
  }
}

const FILE_ACTIONS: Record<string, [string, string]> = {
  DOWNLOAD: ["file.download", "File downloaded"],
  UPLOAD: ["file.upload", "File uploaded"],
  "DOWNLOAD-PARTIAL": ["file.download_partial", "File download cut short"],
  "UPLOAD-PARTIAL": ["file.upload_partial", "File upload cut short"],
};

export function accessRecord(row: AccessRow): LogRecord {
  const code = row.reason?.trim().split(/\s+/)[0] ?? "";
  const deny = row.decision === "DENY";
  const who = row.userEmail ?? "someone";
  const where = row.siteName ?? row.host;
  const reasonText = accessReasonLabel(row.reason);
  let category: LogCategory;
  let action: string;
  let name: string;
  let message: string;
  if (row.host === "manager") {
    // Written by the console itself (a recording erased, a replay opened): an
    // admin's doing, kept in this log for its chain.
    category = "admin";
    action = `system.${row.method.toLowerCase()}`;
    name = "Console action";
    message = row.reason ?? `${row.method} ${row.path}`;
  } else if (code === "session_open" || code === "session_close") {
    category = "session";
    action = code === "session_open" ? "session.open" : "session.close";
    name = code === "session_open" ? "Session opened" : "Session closed";
    const how = isNativeRdpMethod(row.method) ? " with their own RDP app" : isNativeSshMethod(row.method) ? " with their own SSH app" : "";
    // session_close carries the session's length after the code ("45s", "1h05m").
    const length = row.reason?.trim().split(/\s+/).find((w) => /^\d+[smh]/.test(w));
    message = code === "session_open" ? `${who} opened a session to ${where}${how}` : `${who} closed the session to ${where}${length ? ` after ${length}` : ""}`;
  } else if ((TRANSFER_VERBS as readonly string[]).includes(row.method)) {
    category = "file";
    [action, name] = FILE_ACTIONS[row.method];
    const file = row.path.split("/").pop() || row.path;
    message = `${who}: ${name.toLowerCase()} ${file} on ${where}`;
  } else {
    category = "request";
    action = deny ? "access.deny" : "access.request";
    name = deny ? "Access denied" : "Web request";
    message = `${who} ${row.method} ${row.path} on ${where}`;
  }
  if (deny && category !== "request") {
    action = `${action}.deny`;
    name = `${name} (denied)`;
  }
  if (deny && reasonText) message = `${message}: denied, ${reasonText.toLowerCase()}`;
  return {
    source: "access", seq: row.seq, at: row.timestamp, category, action, name, outcome: deny ? "deny" : "allow",
    user: row.userEmail, userName: row.userName, company: row.company,
    resource: row.siteName, resourceId: row.siteId, host: row.host,
    // A session's reason only restates the event; its status is the tunnel's upgrade.
    method: row.method, path: row.path, status: category === "session" ? null : row.status || null, bytes: Number(row.bytesOut) || null,
    reason: category === "session" && !deny ? null : reasonText, clientIp: row.clientIp, userAgent: row.userAgent, target: null,
    message, hash: row.hash,
  };
}

export function adminRecord(row: AdminRow): LogRecord {
  return {
    source: "admin", seq: row.seq ?? BigInt(0), at: row.timestamp, category: "admin", action: row.action, name: "Console action",
    outcome: "allow", user: row.actorEmail, userName: null, company: null,
    resource: null, resourceId: null, host: null, method: null, path: null, status: null, bytes: null,
    reason: null, clientIp: row.clientIp, userAgent: null,
    target: row.targetType ? `${row.targetType}${row.targetId ? `:${row.targetId}` : ""}` : null,
    message: `${row.actorEmail ?? "The platform"}: ${row.summary}`, hash: row.hash,
  };
}

/** The record "Send test" delivers. */
export function testRecord(actorEmail: string | null, at = new Date()): LogRecord {
  return {
    ...adminRecord({ seq: BigInt(0), timestamp: at, actorEmail, action: "test", targetType: null, targetId: null, summary: "", clientIp: null, hash: "" }),
    name: "Test message",
    message: "Test from Captivo Access: this destination receives the workspace's audit records.",
  };
}

/** Three typical records, for the form's preview. */
export function sampleRecords(at = new Date("2026-11-20T09:14:03.120Z")): LogRecord[] {
  const base = {
    userEmail: "ayse@vendor.example", userName: "Ayşe Yılmaz", company: "Vendor Ltd", siteId: "cm0dc01", siteName: "DC01",
    host: "dc01.corp.local", path: "/", status: 0, bytesOut: BigInt(0), clientIp: "203.0.113.24", userAgent: "Mozilla/5.0", hash: "9f2c…",
  };
  return [
    accessRecord({ ...base, seq: BigInt(1042), timestamp: at, method: "GET", decision: "ALLOW", reason: "session_open" }),
    accessRecord({ ...base, seq: BigInt(1043), timestamp: new Date(at.getTime() + 4_000), siteName: "Finance app", siteId: "cm0fin", host: "finance.corp.local", method: "GET", path: "/reports", status: 403, decision: "DENY", reason: "off_schedule" }),
    adminRecord({ seq: BigInt(311), timestamp: new Date(at.getTime() + 9_000), actorEmail: "admin@customer.example", action: "grant.create", targetType: "grant", targetId: "cm0g7", summary: "Granted Ayşe Yılmaz access to DC01 until 18:00", clientIp: "198.51.100.7", hash: "41ab…" }),
  ];
}
