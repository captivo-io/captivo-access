import type { GuacParams } from "@/lib/gateway/guac-params";

// Form-friendly shape: every field is a string ("" = use default). Toggles are a
// 3-way select ("" default / "on" / "off") so an override can also force OFF.
export interface GuacFields {
  serverLayout: string;
  colorDepth: string;
  enableWallpaper: string;
  enableTheming: string;
  enableFontSmoothing: string;
  enableFullWindowDrag: string;
  fileTransfer: string;
  blockUpload: string;
  audio: string; // "" inherit | "on" | "off"  (off → disable-audio)
  printing: string; // "" | "on" | "off"
  terminalFontSize: string;
  terminalColorScheme: string;
  terminalScrollback: string;
  terminalType: string;
  blockDownload: string;
  sftpRoot: string;
  rdpSecurity: string;
}

export const EMPTY_GUAC_FIELDS: GuacFields = {
  serverLayout: "", colorDepth: "", enableWallpaper: "", enableTheming: "", enableFontSmoothing: "", enableFullWindowDrag: "",
  fileTransfer: "", blockUpload: "", blockDownload: "", sftpRoot: "", rdpSecurity: "",
  audio: "", printing: "", terminalFontSize: "", terminalColorScheme: "", terminalScrollback: "", terminalType: "",
};

export const TOGGLES: { key: keyof GuacFields; label: string }[] = [
  { key: "enableWallpaper", label: "Desktop wallpaper" },
  { key: "enableTheming", label: "Window theming" },
  { key: "enableFontSmoothing", label: "Font smoothing" },
  { key: "enableFullWindowDrag", label: "Full-window drag" },
];

export function paramsToGuacFields(p: GuacParams): GuacFields {
  const tri = (b?: boolean) => (b === undefined ? "" : b ? "on" : "off");
  return {
    serverLayout: p.serverLayout ?? "",
    colorDepth: p.colorDepth ? String(p.colorDepth) : "",
    enableWallpaper: tri(p.enableWallpaper),
    enableTheming: tri(p.enableTheming),
    enableFontSmoothing: tri(p.enableFontSmoothing),
    enableFullWindowDrag: tri(p.enableFullWindowDrag),
    fileTransfer: tri(p.enableFileTransfer),
    blockUpload: tri(p.blockUpload),
    blockDownload: tri(p.blockDownload),
    sftpRoot: p.sftpRoot ?? "",
    audio: p.disableAudio === undefined ? "" : p.disableAudio ? "off" : "on",
    printing: tri(p.enablePrinting),
    terminalFontSize: p.terminalFontSize?.toString() ?? "",
    terminalColorScheme: p.terminalColorScheme ?? "",
    terminalScrollback: p.terminalScrollback?.toString() ?? "",
    terminalType: p.terminalType ?? "",
    rdpSecurity: p.rdpSecurity ?? "",
  };
}

export function guacFieldsToParams(f: GuacFields): GuacParams {
  const p: GuacParams = {};
  if (f.serverLayout) p.serverLayout = f.serverLayout;
  if (f.colorDepth) p.colorDepth = Number(f.colorDepth) as 8 | 16 | 24;
  for (const { key } of TOGGLES) {
    if (f[key] === "on") (p as Record<string, unknown>)[key] = true;
    else if (f[key] === "off") (p as Record<string, unknown>)[key] = false;
  }
  const triToBool = (v: string, k: "enableFileTransfer" | "blockUpload" | "blockDownload" | "enablePrinting") => {
    if (v === "on") (p as Record<string, unknown>)[k] = true;
    else if (v === "off") (p as Record<string, unknown>)[k] = false;
  };
  triToBool(f.fileTransfer, "enableFileTransfer");
  triToBool(f.blockUpload, "blockUpload");
  triToBool(f.blockDownload, "blockDownload");
  if (f.sftpRoot.trim()) p.sftpRoot = f.sftpRoot.trim();
  if (f.audio === "off") p.disableAudio = true;
  else if (f.audio === "on") p.disableAudio = false;
  triToBool(f.printing, "enablePrinting");
  if (f.terminalFontSize.trim()) p.terminalFontSize = Number(f.terminalFontSize);
  if (f.terminalColorScheme) p.terminalColorScheme = f.terminalColorScheme;
  if (f.terminalScrollback.trim()) p.terminalScrollback = Number(f.terminalScrollback);
  if (f.terminalType === "xterm-256color" || f.terminalType === "linux") p.terminalType = f.terminalType;
  if (f.rdpSecurity) p.rdpSecurity = f.rdpSecurity;
  return p;
}
