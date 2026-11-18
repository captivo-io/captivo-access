// SMTP presets on the Email page. A preset only fills the form; nothing about
// it is stored, so on load it is read back from the saved host.

export type PresetKey = "m365" | "google" | "sendgrid" | "ses" | "custom";

export interface Preset {
  key: PresetKey;
  label: string;
  /** null: leave the host as it is (Custom), or let the admin fill the region (SES). */
  host: string | null;
  hostHint?: string;
  port: number | null;
  secure: boolean;
}

export const PRESETS: Preset[] = [
  { key: "m365", label: "Microsoft 365", host: "smtp.office365.com", port: 587, secure: false },
  { key: "google", label: "Google Workspace", host: "smtp.gmail.com", port: 587, secure: false },
  { key: "sendgrid", label: "SendGrid", host: "smtp.sendgrid.net", port: 587, secure: false },
  { key: "ses", label: "Amazon SES", host: null, hostHint: "email-smtp.<region>.amazonaws.com", port: 587, secure: false },
  { key: "custom", label: "Custom", host: null, hostHint: "smtp.example.com", port: null, secure: false },
];

export function presetFor(host: string): PresetKey | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  if (h === "smtp.office365.com") return "m365";
  if (h === "smtp.gmail.com" || h === "smtp-relay.gmail.com") return "google";
  if (h === "smtp.sendgrid.net") return "sendgrid";
  if (/^email-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return "ses";
  return "custom";
}
