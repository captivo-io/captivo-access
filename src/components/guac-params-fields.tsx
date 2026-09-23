"use client";
import { KEYBOARD_LAYOUTS, type GuacParams } from "@/lib/gateway/guac-params";

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
  blockDownload: string;
  sftpRoot: string;
  rdpSecurity: string;
}

export const EMPTY_GUAC_FIELDS: GuacFields = {
  serverLayout: "", colorDepth: "", enableWallpaper: "", enableTheming: "", enableFontSmoothing: "", enableFullWindowDrag: "",
  fileTransfer: "", blockUpload: "", blockDownload: "", sftpRoot: "", rdpSecurity: "",
};

const TOGGLES: { key: keyof GuacFields; label: string }[] = [
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
  const triToBool = (v: string, k: "enableFileTransfer" | "blockUpload" | "blockDownload") => {
    if (v === "on") (p as Record<string, unknown>)[k] = true;
    else if (v === "off") (p as Record<string, unknown>)[k] = false;
  };
  triToBool(f.fileTransfer, "enableFileTransfer");
  triToBool(f.blockUpload, "blockUpload");
  triToBool(f.blockDownload, "blockDownload");
  if (f.sftpRoot.trim()) p.sftpRoot = f.sftpRoot.trim();
  if (f.rdpSecurity) p.rdpSecurity = f.rdpSecurity;
  return p;
}

// protocol: undefined = show all (Policy defaults); RDP = all; VNC = colour depth only; SSH = none.
// policy: the resolved Policy defaults when editing a RESOURCE — the empty option then
// reads "Inherit policy (On/Off)" so the effective value is visible. Without it (the
// Policy page itself) the empty option is the session engine's built-in default.
export function GuacParamsFields({ value, onChange, protocol, policy }: { value: GuacFields; onChange: (v: GuacFields) => void; protocol?: "RDP" | "SSH" | "VNC"; policy?: GuacParams }) {
  const set = (k: keyof GuacFields, v: string) => onChange({ ...value, [k]: v });
  // Label for the "" option: what actually applies when nothing is chosen here.
  const onOff = (v: boolean | undefined, engineDefault: boolean) => ((v ?? engineDefault) ? "On" : "Off");
  const inherit = (effective: string) => (policy ? `Inherit policy (${effective})` : `Engine default (${effective})`);
  const ftLabel = inherit(onOff(policy?.enableFileTransfer, false));
  const blockUpLabel = inherit(policy?.blockUpload ? "blocked" : "allowed");
  const blockDownLabel = inherit(policy?.blockDownload ? "blocked" : "allowed");
  const depthLabel = inherit(policy?.colorDepth ? `${policy.colorDepth}-bit` : "auto");
  const layoutLabel = policy?.serverLayout ? `Inherit policy (${KEYBOARD_LAYOUTS.find((l) => l.value === policy.serverLayout)?.label ?? policy.serverLayout})` : inherit("US English");
  const securityLabel = inherit(policy?.rdpSecurity ? policy.rdpSecurity.toUpperCase() : "negotiate");
  const showLayout = !protocol || protocol === "RDP";
  const showDepth = !protocol || protocol === "RDP" || protocol === "VNC";
  const showPerf = !protocol || protocol === "RDP";
  const showSecurity = !protocol || protocol === "RDP";
  const showFt = !protocol || protocol === "RDP" || protocol === "SSH";
  const showSftpRoot = !protocol || protocol === "SSH";
  return (
    <div className="guac-fields">
      {showLayout && (
        <label className="field"><span className="field-label">Keyboard layout {protocol ? "" : "(RDP)"}</span>
          <select className="select" value={value.serverLayout} onChange={(e) => set("serverLayout", e.target.value)}>
            {KEYBOARD_LAYOUTS.map((l) => <option key={l.value} value={l.value}>{l.value === "" ? layoutLabel : l.label}</option>)}
          </select>
        </label>
      )}
      {showSecurity && (
        <label className="field"><span className="field-label">RDP security {protocol ? "" : "(RDP)"}</span>
          <select className="select" value={value.rdpSecurity} onChange={(e) => set("rdpSecurity", e.target.value)}>
            <option value="">{securityLabel}</option>
            <option value="nla">NLA</option>
            <option value="tls">TLS</option>
            <option value="rdp">RDP (legacy)</option>
          </select>
          <span className="hint">Set to NLA if an updated Windows host refuses the connection (&quot;wrong security type&quot;).</span>
        </label>
      )}
      {showDepth && (
        <label className="field"><span className="field-label">Colour depth</span>
          <select className="select" value={value.colorDepth} onChange={(e) => set("colorDepth", e.target.value)}>
            <option value="">{depthLabel}</option>
            <option value="24">24-bit</option>
            <option value="16">16-bit</option>
            <option value="8">8-bit</option>
          </select>
        </label>
      )}
      {showPerf && TOGGLES.map(({ key, label }) => (
        <label className="field" key={key}><span className="field-label">{label} {protocol ? "" : "(RDP)"}</span>
          <select className="select" value={value[key]} onChange={(e) => set(key, e.target.value)}>
            <option value="">{inherit(onOff(policy?.[key as "enableWallpaper" | "enableTheming" | "enableFontSmoothing" | "enableFullWindowDrag"], false))}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      ))}
      {showFt && (
        <label className="field"><span className="field-label">File transfer</span>
          <select className="select" value={value.fileTransfer} onChange={(e) => set("fileTransfer", e.target.value)}>
            <option value="">{ftLabel}</option><option value="on">On</option><option value="off">Off</option>
          </select>
          <span className="field-hint">The master switch: opens the file channel (SFTP for SSH, a mapped &quot;Captivo&quot; drive for RDP) so vendors can drop files in and download out. Off = no channel at all. Block upload / download below narrow the direction once it is on.</span>
        </label>
      )}
      {showFt && value.fileTransfer !== "off" && (
        <label className="field"><span className="field-label">Block upload</span>
          <select className="select" value={value.blockUpload} onChange={(e) => set("blockUpload", e.target.value)}>
            <option value="">{blockUpLabel}</option><option value="on">On (vendor cannot send files in)</option><option value="off">Off (upload allowed)</option>
          </select>
        </label>
      )}
      {showFt && value.fileTransfer !== "off" && (
        <label className="field"><span className="field-label">Block download</span>
          <select className="select" value={value.blockDownload} onChange={(e) => set("blockDownload", e.target.value)}>
            <option value="">{blockDownLabel}</option><option value="on">On (vendor cannot take files out)</option><option value="off">Off (download allowed)</option>
          </select>
        </label>
      )}
      {showSftpRoot && value.fileTransfer !== "off" && (
        <label className="field"><span className="field-label">SFTP upload folder {protocol ? "" : "(SSH)"}</span>
          <input className="input" type="text" value={value.sftpRoot} placeholder={policy?.sftpRoot ? `Inherit policy (${policy.sftpRoot})` : "Auto (the user's home directory)"}
            onChange={(e) => set("sftpRoot", e.target.value)} />
          <span className="field-hint">Absolute path on the target where uploaded files are written. Leave blank to use the login user&apos;s home.</span>
        </label>
      )}
    </div>
  );
}
