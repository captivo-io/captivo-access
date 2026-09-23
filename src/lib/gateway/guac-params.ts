export interface GuacParams {
  serverLayout?: string;
  colorDepth?: 8 | 16 | 24;
  enableWallpaper?: boolean;
  enableTheming?: boolean;
  enableFontSmoothing?: boolean;
  enableFullWindowDrag?: boolean;
  enableFileTransfer?: boolean;
  blockUpload?: boolean;
  blockDownload?: boolean;
  sftpRoot?: string;
  rdpSecurity?: string;
  // RDP: audio playback to the vendor (guacd default on) and print-to-PDF (jobs
  // arrive as downloads); SSH: terminal look.
  disableAudio?: boolean;
  enablePrinting?: boolean;
  terminalFontSize?: number;
  terminalColorScheme?: string;
  terminalScrollback?: number;
}

export const TERMINAL_COLOR_SCHEMES: { value: string; label: string }[] = [
  { value: "", label: "Default (gray on black)" },
  { value: "gray-black", label: "Gray on black" },
  { value: "black-white", label: "Black on white" },
  { value: "green-black", label: "Green on black" },
  { value: "white-black", label: "White on black" },
];

export const KEYBOARD_LAYOUTS: { value: string; label: string }[] = [
  { value: "", label: "Default (US English)" },
  { value: "en-us-qwerty", label: "English (US)" },
  { value: "en-gb-qwerty", label: "English (UK)" },
  { value: "tr-tr-qwerty", label: "Turkish-Q" },
  { value: "de-de-qwertz", label: "German" },
  { value: "de-ch-qwertz", label: "German (Swiss)" },
  { value: "fr-fr-azerty", label: "French" },
  { value: "fr-be-azerty", label: "French (Belgian)" },
  { value: "fr-ch-qwertz", label: "French (Swiss)" },
  { value: "es-es-qwerty", label: "Spanish" },
  { value: "es-latam-qwerty", label: "Spanish (Latin American)" },
  { value: "it-it-qwerty", label: "Italian" },
  { value: "ja-jp-qwerty", label: "Japanese" },
  { value: "pt-br-qwerty", label: "Portuguese (Brazilian)" },
  { value: "sv-se-qwerty", label: "Swedish" },
  { value: "no-no-qwerty", label: "Norwegian" },
  { value: "hu-hu-qwertz", label: "Hungarian" },
];

const LAYOUTS = new Set(KEYBOARD_LAYOUTS.map((l) => l.value).filter(Boolean));
const DEPTHS = new Set([8, 16, 24]);
const RDP_SECURITY = new Set(["any", "nla", "tls", "rdp"]);
const BOOL_KEYS = ["enableWallpaper", "enableTheming", "enableFontSmoothing", "enableFullWindowDrag", "enableFileTransfer", "blockUpload", "blockDownload", "disableAudio", "enablePrinting"] as const;
const SCHEMES = new Set(TERMINAL_COLOR_SCHEMES.map((c) => c.value).filter(Boolean));

// Coerce untrusted JSON into GuacParams, keeping ONLY curated keys with valid values.
export function parseGuacParams(input: unknown): GuacParams {
  const out: GuacParams = {};
  if (!input || typeof input !== "object") return out;
  const o = input as Record<string, unknown>;
  if (typeof o.serverLayout === "string" && LAYOUTS.has(o.serverLayout)) out.serverLayout = o.serverLayout;
  if (typeof o.colorDepth === "number" && DEPTHS.has(o.colorDepth)) out.colorDepth = o.colorDepth as 8 | 16 | 24;
  for (const k of BOOL_KEYS) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  if (typeof o.sftpRoot === "string") {
    const v = o.sftpRoot.trim();
    // Absolute path only (guacd rejects relative SFTP roots), bounded, no control chars.
    if (v.startsWith("/") && v.length <= 1024 && !/[\x00-\x1f]/.test(v)) out.sftpRoot = v;
  }
  if (typeof o.rdpSecurity === "string" && RDP_SECURITY.has(o.rdpSecurity)) out.rdpSecurity = o.rdpSecurity;
  const fs = typeof o.terminalFontSize === "string" && o.terminalFontSize.trim() ? Number(o.terminalFontSize) : o.terminalFontSize;
  if (typeof fs === "number" && Number.isInteger(fs) && fs >= 8 && fs <= 32) out.terminalFontSize = fs;
  if (typeof o.terminalColorScheme === "string" && SCHEMES.has(o.terminalColorScheme)) out.terminalColorScheme = o.terminalColorScheme;
  const sb = typeof o.terminalScrollback === "string" && o.terminalScrollback.trim() ? Number(o.terminalScrollback) : o.terminalScrollback;
  if (typeof sb === "number" && Number.isInteger(sb) && sb >= 100 && sb <= 100000) out.terminalScrollback = sb;
  return out;
}

// Per-field: resource value if present, else policy default. (undefined = guacd default.)
export function resolveGuacParams(resource: GuacParams, policy: GuacParams): GuacParams {
  return {
    serverLayout: resource.serverLayout ?? policy.serverLayout,
    colorDepth: resource.colorDepth ?? policy.colorDepth,
    enableWallpaper: resource.enableWallpaper ?? policy.enableWallpaper,
    enableTheming: resource.enableTheming ?? policy.enableTheming,
    enableFontSmoothing: resource.enableFontSmoothing ?? policy.enableFontSmoothing,
    enableFullWindowDrag: resource.enableFullWindowDrag ?? policy.enableFullWindowDrag,
    enableFileTransfer: resource.enableFileTransfer ?? policy.enableFileTransfer,
    blockUpload: resource.blockUpload ?? policy.blockUpload,
    blockDownload: resource.blockDownload ?? policy.blockDownload,
    sftpRoot: resource.sftpRoot ?? policy.sftpRoot,
    rdpSecurity: resource.rdpSecurity ?? policy.rdpSecurity,
    disableAudio: resource.disableAudio ?? policy.disableAudio,
    enablePrinting: resource.enablePrinting ?? policy.enablePrinting,
    terminalFontSize: resource.terminalFontSize ?? policy.terminalFontSize,
    terminalColorScheme: resource.terminalColorScheme ?? policy.terminalColorScheme,
    terminalScrollback: resource.terminalScrollback ?? policy.terminalScrollback,
  };
}

// The writable SFTP root for an SSH target: the login user's home. guacd defaults
// sftp-root-directory to "/", which non-root users can't write to → "Unable to
// write to file". Absolute path required (guacd rejects relative roots).
export function sshHome(username?: string): string {
  if (username === "root") return "/root";
  if (username && username.length > 0) return "/home/" + username;
  return "/";
}

// Map resolved params + clipboardMode → guacd arg-name→value (only set/true fields).
export function toGuacArgs(p: GuacParams, clipboardMode: string, protocol: "RDP" | "SSH" | "VNC", username?: string): Record<string, string> {
  const a: Record<string, string> = {};
  if (p.serverLayout) a["server-layout"] = p.serverLayout;
  if (p.colorDepth) a["color-depth"] = String(p.colorDepth);
  if (p.enableWallpaper) a["enable-wallpaper"] = "true";
  if (p.enableTheming) a["enable-theming"] = "true";
  if (p.enableFontSmoothing) a["enable-font-smoothing"] = "true";
  if (p.enableFullWindowDrag) a["enable-full-window-drag"] = "true";
  if (clipboardMode === "no_copy" || clipboardMode === "none") a["disable-copy"] = "true";
  if (clipboardMode === "no_paste" || clipboardMode === "none") a["disable-paste"] = "true";
  if (protocol === "RDP" && p.rdpSecurity) a["security"] = p.rdpSecurity;
  if (protocol === "RDP" && p.disableAudio) a["disable-audio"] = "true";
  if (protocol === "RDP" && p.enablePrinting) {
    a["enable-printing"] = "true";
    a["printer-name"] = "Captivo Printer";
  }
  if (protocol === "SSH") {
    if (p.terminalFontSize) a["font-size"] = String(p.terminalFontSize);
    if (p.terminalColorScheme) a["color-scheme"] = p.terminalColorScheme;
    if (p.terminalScrollback) a["scrollback"] = String(p.terminalScrollback);
  }
  if (p.enableFileTransfer) {
    if (protocol === "RDP") {
      a["enable-drive"] = "true";
      a["create-drive-path"] = "true";
      a["drive-name"] = "Captivo";
      if (p.blockUpload) a["disable-upload"] = "true";
      if (p.blockDownload) a["disable-download"] = "true";
    } else if (protocol === "SSH") {
      a["enable-sftp"] = "true";
      a["sftp-root-directory"] = (p.sftpRoot && p.sftpRoot.trim()) || sshHome(username);
      if (p.blockUpload) a["sftp-disable-upload"] = "true";
      if (p.blockDownload) a["sftp-disable-download"] = "true";
    }
  }
  return a;
}
