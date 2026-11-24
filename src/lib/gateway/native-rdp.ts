import { compareSemver } from "@/lib/updates/semver";
import type { GuacParams } from "@/lib/gateway/guac-params";

// Native RDP: a remote desktop resource the user may also open in their own
// Remote Desktop client (mstsc, the Windows App, FreeRDP) through the data
// plane's RD Gateway.
//
// On a recorded resource the session is recorded: the data plane ends the
// client's TLS inside the gateway tunnel and the connector signs in to the
// server with the saved account (dataplane/rdprec.go, connector/rdprec.go), so
// the user types no password, and the screen and keys are recorded. That needs
// connector 2.52.0. On a resource that is not recorded, or a recorded one whose
// connector is older (while the Policy doesn't require recording), the RDP
// stream runs end to end between the client and the server and Captivo sees
// none of it.

/** The first connector that relays native RDP (the "rdp" tunnel stream). */
export const NATIVE_RDP_MIN_CONNECTOR = "2.39.0";

/** Connectors sign in for a recorded native RDP session from this release on. */
export const NATIVE_RDP_RECORDED_MIN_CONNECTOR = "2.52.0";

export type NativeRdpBlock = "off" | "not_rdp" | "recording_required" | "connector_outdated";
export type NativeRdpMode = "recorded" | "direct";

type NativeRdpFacts = {
  accessMode: string; nativeRdp: boolean; protocol: string | null | undefined;
  /** Sessions on this resource are recorded (the Policy and its own setting). */
  recorded?: boolean;
  recordingRequired: boolean; connectorVersion: string | null | undefined;
};

/** How the user's own RDP client reaches this resource now, or why it can't. */
export function nativeRdpMode(s: NativeRdpFacts): NativeRdpMode | NativeRdpBlock {
  if (s.accessMode !== "GATEWAY" || String(s.protocol ?? "").toUpperCase() !== "RDP") return "not_rdp";
  if (!s.nativeRdp) return "off";
  const recorded = s.recorded || s.recordingRequired;
  // A version that isn't plain semver (a dev build) is let through; the gateway
  // still reports a connector that can't carry the stream.
  if (recorded && compareSemver(s.connectorVersion, NATIVE_RDP_RECORDED_MIN_CONNECTOR) !== -1) return "recorded";
  if (s.recordingRequired) return "connector_outdated";
  if (compareSemver(s.connectorVersion, NATIVE_RDP_MIN_CONNECTOR) === -1) return "connector_outdated";
  return "direct";
}

/** Why a resource can't be opened natively right now, or null when it can. */
export function nativeRdpBlock(s: NativeRdpFacts): NativeRdpBlock | null {
  const m = nativeRdpMode(s);
  return m === "recorded" || m === "direct" ? null : m;
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
 * Static channels a recorded session keeps closed on the server, from the
 * resource's rules: the clipboard, and device redirection when neither drives
 * nor printers may come through (both share one channel).
 */
export function blockedChannels(r: NativeRedirection): string[] {
  const out: string[] = [];
  if (!r.clipboard) out.push("cliprdr");
  if (!r.drives && !r.printers) out.push("rdpdr");
  return out;
}

/**
 * The .rdp file: the server, our RD Gateway with the ticket as its access
 * token, and the same redirection the gateway enforces, so the client doesn't
 * offer what will be refused. The user signs in to the server themselves,
 * except on a recorded session: there the computer named is the console
 * (whose certificate the data plane shows inside the tunnel) and the client
 * asks for no credentials, as Captivo signs in.
 */
export function rdpFile(o: { gatewayHost: string; targetHost: string; targetPort: number; token: string; redirection: NativeRedirection; recorded?: boolean }): string {
  const address = o.recorded ? o.gatewayHost.replace(/:\d+$/, "") : o.targetPort === 3389 ? o.targetHost : `${o.targetHost}:${o.targetPort}`;
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
    `enablecredsspsupport:i:${o.recorded ? 0 : 1}`,
    // Recorded: no tiles from the app's disk cache, which the recording never sees (black regions).
    ...(o.recorded ? ["prompt for credentials:i:0", "bitmapcachepersistenable:i:0"] : []),
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
