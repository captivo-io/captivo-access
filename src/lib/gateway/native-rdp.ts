import { compareSemver } from "@/lib/updates/semver";
import type { GuacParams } from "@/lib/gateway/guac-params";

// Native RDP: a remote desktop resource the user may also open in their own
// Remote Desktop client (mstsc, the Windows App, FreeRDP) through the data
// plane's RD Gateway. The RDP stream is end-to-end between that client and the
// server, so Captivo can't record it, log keystrokes, sign in for the user or
// let an admin watch. A recorded resource may still offer it: its browser
// sessions stay recorded and the native ones are marked as not recorded. Only
// a Policy that requires recording turns it off.

/** The first connector that relays native RDP (the "rdp" tunnel stream). */
export const NATIVE_RDP_MIN_CONNECTOR = "2.39.0";

export type NativeRdpBlock = "off" | "not_rdp" | "recording_required" | "connector_outdated";

/**
 * Why a resource can't be opened natively right now, or null when it can.
 * `recorded` is the effective decision (capability, tenant policy, the toggle).
 */
export function nativeRdpBlock(s: { accessMode: string; nativeRdp: boolean; protocol: string | null | undefined; recordingRequired: boolean; connectorVersion: string | null | undefined }): NativeRdpBlock | null {
  if (s.accessMode !== "GATEWAY" || String(s.protocol ?? "").toUpperCase() !== "RDP") return "not_rdp";
  if (!s.nativeRdp) return "off";
  if (s.recordingRequired) return "recording_required";
  // A version that isn't plain semver (a dev build) is let through; the gateway
  // still reports a connector that can't relay the stream.
  if (compareSemver(s.connectorVersion, NATIVE_RDP_MIN_CONNECTOR) === -1) return "connector_outdated";
  return null;
}

// MS-TSGU tunnel redirection flags (HTTP_TUNNEL_REDIR_*): the gateway tells the
// client which devices it must not redirect. The client applies them, so they
// hold for mstsc and other well-behaved clients, not against a modified one.
const REDIR_DISABLE_DRIVE = 0x01;
const REDIR_DISABLE_PRINTER = 0x02;
const REDIR_DISABLE_PORT = 0x04;
const REDIR_DISABLE_CLIPBOARD = 0x08;
const REDIR_DISABLE_PNP = 0x10;

export interface NativeRedirection { clipboard: boolean; drives: boolean; printers: boolean }

/**
 * What the resource's own rules allow, mapped to a native client. A native
 * client can't block one direction, so a one-way rule (paste only, upload only)
 * turns the whole channel off. Serial ports and plug-and-play devices are
 * always off.
 */
export function nativeRedirection(clipboardMode: string, g: GuacParams): NativeRedirection {
  return {
    clipboard: clipboardMode === "allow",
    drives: !!g.enableFileTransfer && !g.blockUpload && !g.blockDownload,
    printers: !!g.enablePrinting,
  };
}

export function redirectFlags(r: NativeRedirection): number {
  return (r.drives ? 0 : REDIR_DISABLE_DRIVE) | (r.printers ? 0 : REDIR_DISABLE_PRINTER) | REDIR_DISABLE_PORT | (r.clipboard ? 0 : REDIR_DISABLE_CLIPBOARD) | REDIR_DISABLE_PNP;
}

const oneLine = (v: string) => v.replace(/[\r\n]/g, "");

/**
 * The .rdp file: the server, our RD Gateway with the ticket as its access
 * token, and the same redirection the gateway enforces, so the client doesn't
 * offer what will be refused. The user signs in to the server themselves.
 */
export function rdpFile(o: { gatewayHost: string; targetHost: string; targetPort: number; token: string; redirection: NativeRedirection }): string {
  const address = o.targetPort === 3389 ? o.targetHost : `${o.targetHost}:${o.targetPort}`;
  const r = o.redirection;
  const lines = [
    `full address:s:${oneLine(address)}`,
    `gatewayhostname:s:${oneLine(o.gatewayHost)}`,
    "gatewayusagemethod:i:1",
    "gatewaycredentialssource:i:5",
    "gatewayprofileusagemethod:i:1",
    "promptcredentialonce:i:0",
    `gatewayaccesstoken:s:${oneLine(o.token)}`,
    "authentication level:i:2",
    "enablecredsspsupport:i:1",
    "screen mode id:i:2",
    "smart sizing:i:1",
    "dynamic resolution:i:1",
    `redirectclipboard:i:${r.clipboard ? 1 : 0}`,
    `redirectprinters:i:${r.printers ? 1 : 0}`,
    `drivestoredirect:s:${r.drives ? "*" : ""}`,
    "redirectcomports:i:0",
    "devicestoredirect:s:",
    "usbdevicestoredirect:s:",
    "autoreconnection enabled:i:0",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** A download name from the resource's name. */
export function rdpFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^\w .-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `${base || "remote-desktop"}.rdp`;
}
