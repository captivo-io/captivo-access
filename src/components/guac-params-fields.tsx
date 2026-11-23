"use client";
import { TERMINAL_COLOR_SCHEMES, KEYBOARD_LAYOUTS, type GuacParams } from "@/lib/gateway/guac-params";

import { TOGGLES, type GuacFields } from "@/lib/gateway/guac-fields";
export { EMPTY_GUAC_FIELDS, paramsToGuacFields, guacFieldsToParams, type GuacFields } from "@/lib/gateway/guac-fields";

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
  const showAudio = !protocol || protocol === "RDP";
  const showTerminal = !protocol || protocol === "SSH";
  const audioLabel = inherit(policy?.disableAudio ? "Off" : "On");
  const printLabel = inherit(onOff(policy?.enablePrinting, false));
  const fontLabel = policy?.terminalFontSize ? `Inherit policy (${policy.terminalFontSize} pt)` : inherit("12 pt");
  const schemeLabel = policy?.terminalColorScheme ? `Inherit policy (${TERMINAL_COLOR_SCHEMES.find((c) => c.value === policy.terminalColorScheme)?.label ?? policy.terminalColorScheme})` : inherit("gray on black");
  const scrollLabel = policy?.terminalScrollback ? `Inherit policy (${policy.terminalScrollback} lines)` : inherit("1000 lines");
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
      {showAudio && (
        <label className="field"><span className="field-label">Sound {protocol ? "" : "(RDP)"}</span>
          <select className="select" value={value.audio} onChange={(e) => set("audio", e.target.value)}>
            <option value="">{audioLabel}</option><option value="on">On (remote audio plays in the vendor&apos;s browser)</option><option value="off">Off</option>
          </select>
        </label>
      )}
      {showAudio && (
        <label className="field"><span className="field-label">Printing {protocol ? "" : "(RDP)"}</span>
          <select className="select" value={value.printing} onChange={(e) => set("printing", e.target.value)}>
            <option value="">{printLabel}</option><option value="on">On (a &quot;Captivo Printer&quot; that prints to PDF, delivered as a download)</option><option value="off">Off</option>
          </select>
        </label>
      )}
      {showTerminal && (
        <label className="field"><span className="field-label">Terminal font size {protocol ? "" : "(SSH)"}</span>
          <select className="select" value={value.terminalFontSize} onChange={(e) => set("terminalFontSize", e.target.value)}>
            <option value="">{fontLabel}</option>{[10, 12, 14, 16, 18, 20, 24].map((n) => <option key={n} value={n}>{n} pt</option>)}
          </select>
        </label>
      )}
      {showTerminal && (
        <label className="field"><span className="field-label">Terminal colours {protocol ? "" : "(SSH)"}</span>
          <select className="select" value={value.terminalColorScheme} onChange={(e) => set("terminalColorScheme", e.target.value)}>
            {TERMINAL_COLOR_SCHEMES.map((c) => <option key={c.value} value={c.value}>{c.value === "" ? schemeLabel : c.label}</option>)}
          </select>
        </label>
      )}
      {showTerminal && (
        <label className="field"><span className="field-label">Terminal scrollback {protocol ? "" : "(SSH)"}</span>
          <select className="select" value={value.terminalScrollback} onChange={(e) => set("terminalScrollback", e.target.value)}>
            <option value="">{scrollLabel}</option>{[1000, 5000, 10000, 50000].map((n) => <option key={n} value={n}>{n} lines</option>)}
          </select>
        </label>
      )}
      {showTerminal && (
        <label className="field"><span className="field-label">Terminal type {protocol ? "" : "(SSH)"}</span>
          <select className="select" value={value.terminalType} onChange={(e) => set("terminalType", e.target.value)}>
            <option value="">{policy?.terminalType ? `Inherit policy (${policy.terminalType})` : inherit("xterm-256color")}</option>
            <option value="xterm-256color">xterm-256color</option>
            <option value="linux">linux (old systems without xterm)</option>
          </select>
          <span className="field-hint">What the server is told the terminal is. xterm gives 256 colours, and vim or less leave the shell&apos;s screen as it was; choose linux only for a system that has no xterm entry (it then says &quot;unknown terminal type&quot;).</span>
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
