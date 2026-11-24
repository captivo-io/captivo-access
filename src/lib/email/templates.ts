import { renderEmail, escapeHtml } from "./layout";

export function inviteEmail(input: { name: string; link: string }): { subject: string; html: string; text: string } {
  const subject = "You've been invited to Captivo Access";
  const { html, text } = renderEmail({
    heading: subject,
    bodyLines: [
      `Hi ${escapeHtml(input.name)},`,
      "You've been invited to reach internal applications through Captivo Access. Use the button below to set up your passkey and get started.",
      "This invite link is single-use and time-limited.",
    ],
    button: { label: "Open your invite", url: input.link },
  });
  return { subject, html, text };
}

export function passkeyResetEmail(input: { name: string; link: string }): { subject: string; html: string; text: string } {
  const subject = "Set up a new passkey for Captivo Access";
  const { html, text } = renderEmail({
    heading: subject,
    bodyLines: [
      `Hi ${escapeHtml(input.name)},`,
      "An administrator removed the passkeys on your Captivo Access account. Use the button below to register a new one on this device; until you do, you can't sign in.",
      "This link is single-use and time-limited. If you didn't expect it, tell your administrator.",
    ],
    button: { label: "Set up a new passkey", url: input.link },
  });
  return { subject, html, text };
}

export function approvalRequestEmail(input: {
  vendorName: string;
  vendorEmail: string;
  siteName: string;
  consoleUrl: string;
  ticket?: { ref: string; verified: boolean } | null;
}): { subject: string; html: string; text: string } {
  const subject = `Access request: ${input.siteName}`;
  const { html, text } = renderEmail({
    heading: "Access request pending review",
    bodyLines: [
      `${escapeHtml(input.vendorName)} (${escapeHtml(input.vendorEmail)}) requested access to ${escapeHtml(input.siteName)}.`,
      ...(input.ticket ? [`Ticket: ${escapeHtml(input.ticket.ref)}${input.ticket.verified ? "" : " (not checked: the ticket system did not answer, or none is set up)"}.`] : []),
      "It stays pending — and denied — until an admin approves it.",
    ],
    button: input.consoleUrl ? { label: "Review in the console", url: `${input.consoleUrl}/admin/grants` } : undefined,
  });
  return { subject, html, text };
}

export function accessDecisionEmail(input: {
  decision: "approved" | "denied";
  siteName: string;
  consoleUrl: string;
}): { subject: string; html: string; text: string } {
  const approved = input.decision === "approved";
  const subject = approved ? `Access approved: ${input.siteName}` : `Access request declined: ${input.siteName}`;
  const line = approved
    ? `Your request to access ${escapeHtml(input.siteName)} was approved. It's ready in your access list.`
    : `Your request to access ${escapeHtml(input.siteName)} was declined.`;
  const { html, text } = renderEmail({
    heading: escapeHtml(subject),
    bodyLines: [line],
    button: input.consoleUrl ? { label: "Open My access", url: `${input.consoleUrl}/access` } : undefined,
  });
  return { subject, html, text };
}

export function siteEventEmail(input: {
  type: "site_down" | "site_recovered";
  siteName: string;
  detail: string | null;
  consoleUrl: string;
}): { subject: string; html: string; text: string } {
  const down = input.type === "site_down";
  const subject = down ? `Site down: ${input.siteName}` : `Site recovered: ${input.siteName}`;
  const line = down
    ? `Captivo Access can no longer reach ${escapeHtml(input.siteName)}${input.detail ? ` — ${escapeHtml(input.detail)}` : ""}.`
    : `${escapeHtml(input.siteName)} is reachable again.`;
  const { html, text } = renderEmail({
    heading: escapeHtml(subject),
    bodyLines: [line],
    button: input.consoleUrl ? { label: "View notifications", url: `${input.consoleUrl}/admin/notifications` } : undefined,
  });
  return { subject, html, text };
}

export function workspaceClosedEmail(input: {
  workspace: string;
  closedBy: string;
  restorableUntil: string; // already formatted, e.g. "18 Dec 2026"
  support: string;
}): { subject: string; html: string; text: string } {
  const subject = `Workspace closed: ${input.workspace}`;
  const { html, text } = renderEmail({
    heading: escapeHtml(subject),
    bodyLines: [
      `${escapeHtml(input.closedBy)} closed the Captivo Access workspace <b>${escapeHtml(input.workspace)}</b>. Its console and every app stopped, all sessions ended and its connectors can no longer connect.`,
      `Its data is kept until <b>${escapeHtml(input.restorableUntil)}</b>. To restore it before then, write to ${escapeHtml(input.support)}. After that date it is removed permanently.`,
      "If you did not expect this, contact support straight away.",
    ],
  });
  return { subject, html, text };
}

export function accessReviewEmail(input: {
  kind: "open" | "week" | "day";
  name: string;
  dueText: string;
  pending: number;
  url: string;
}): { subject: string; html: string; text: string } {
  const n = `${input.pending} grant${input.pending === 1 ? "" : "s"}`;
  const subject = input.kind === "open" ? `Access review open: ${input.name}` : `Access review due ${input.kind === "day" ? "tomorrow" : "in a week"}: ${input.name}`;
  const { html, text } = renderEmail({
    heading: escapeHtml(subject),
    bodyLines: [
      input.kind === "open"
        ? `${escapeHtml(input.name)} is open: ${n} to confirm or remove, by ${escapeHtml(input.dueText)}.`
        : `${n} in ${escapeHtml(input.name)} have no decision yet. The review closes ${escapeHtml(input.dueText)}.`,
      "Grants nobody answers for follow the review's rule when it closes: they are removed unless it was set to keep them.",
    ],
    button: input.url ? { label: "Open the review", url: input.url } : undefined,
  });
  return { subject, html, text };
}

export function sessionInviteEmail(input: {
  inviter: string;
  userLabel: string;
  siteName: string;
  canControl: boolean;
  untilSessionEnds: boolean;
  expiresAt: Date;
  link: string;
}): { subject: string; html: string; text: string } {
  const subject = `Join a live session on ${input.siteName}`;
  const minutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000));
  const lasts = input.untilSessionEnds ? "until the session ends" : minutes >= 60 ? `for ${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"}` : `for ${minutes} minutes`;
  const { html, text } = renderEmail({
    heading: escapeHtml(subject),
    bodyLines: [
      `${escapeHtml(input.inviter)} invited you to ${input.canControl ? "watch, and if needed take control of," : "watch"} ${escapeHtml(input.userLabel)}'s session on ${escapeHtml(input.siteName)}, as it happens.`,
      `Sign in with Captivo under this address to join. The link works once, on the browser you open it in, ${lasts}.`,
      "You see only this session. Everything in it is recorded, including that you joined.",
    ],
    button: { label: "Join the session", url: input.link },
  });
  return { subject, html, text };
}

export function moderationRequestEmail(input: {
  userName: string;
  userEmail: string;
  siteName: string;
  consoleUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `Moderator needed: ${input.siteName}`;
  const { html, text } = renderEmail({
    heading: "A session is waiting for a moderator",
    bodyLines: [
      `${escapeHtml(input.userName)} (${escapeHtml(input.userEmail)}) wants to start a session on ${escapeHtml(input.siteName)}, which needs a moderator.`,
      "The session starts when a moderator joins it from Live sessions. The request waits for 10 minutes.",
    ],
    button: input.consoleUrl ? { label: "Open Live sessions", url: `${input.consoleUrl}/admin/live` } : undefined,
  });
  return { subject, html, text };
}
