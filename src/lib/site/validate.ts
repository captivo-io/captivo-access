import { isEgressMode, parseEgressHosts, type EgressMode } from "@/lib/isolation/egress";
import { secretInputFrom, type SecretInput } from "@/lib/vault/secret-input";
import { parseGuacParams, type GuacParams } from "@/lib/gateway/guac-params";
import { DB_ENGINES, dbParamsFrom, type DbEngine, type DbParams } from "@/lib/database/params";
import { kubeParamsFrom, parseApiServer, type KubeParams } from "@/lib/kubernetes/params";

const CLIP = ["allow", "no_copy", "no_paste", "none"];
const FT = ["allow", "no_upload", "no_download", "none"];
const PROTOCOLS = ["RDP", "SSH", "VNC"] as const;

export type SiteValidation =
  | {
      ok: true;
      mode: "TRANSPARENT";
      connectorId: string;
      name: string;
      hostname: string;
      customDomain: boolean;
      upstreamUrl: string;
      description: string | null;
      insecureSkipVerify: boolean;
      clipboardMode: string | null;
      recordSessions: boolean;
      keystrokeLogging: boolean;
      watermark: boolean | null; // null = inherit the Policy default
      fileTransferMode: string | null; // null = inherit the Policy web app default
    }
  | {
      ok: true;
      mode: "GATEWAY";
      connectorId: string;
      name: string;
      description: string | null;
      protocol: "RDP" | "SSH" | "VNC";
      targetHost: string;
      targetPort: number;
      username: string;
      secret: SecretInput | null; // sealed in the browser, or plaintext (API clients)
      recordSessions: boolean;
      keystrokeLogging: boolean;
      watermark: boolean | null; // null = inherit the Policy default
      clipboardMode: string | null; // read by the gateway descriptor (guacd disable-copy/paste)
      guacParams: GuacParams;
      nativeRdp: boolean; // RDP only: also open in the user's own client (lib/gateway/native-rdp.ts)
      nativeSsh: boolean; // SSH only: also reach it with the user's own SSH client (lib/gateway/native-ssh.ts)
      requireModerator: boolean; // a session starts only once a moderator admits it (lib/moderation)
    }
  | {
      ok: true;
      mode: "ISOLATED";
      connectorId: string;
      name: string;
      description: string | null;
      upstreamUrl: string;
      insecureSkipVerify: boolean;
      recordSessions: boolean;
      keystrokeLogging: boolean;
      clipboardMode: string | null;
      watermark: boolean | null;
      fileTransferMode: string | null; // null = inherit the Policy default
      egressMode: EgressMode | null | undefined; // null = inherit the Policy default; undefined = leave as it is
      egressHosts: string[] | undefined;
    }
  | {
      ok: true;
      mode: "DATABASE";
      connectorId: string;
      name: string;
      description: string | null;
      engine: DbEngine;
      targetHost: string;
      targetPort: number;
      username: string;
      secret: SecretInput | null;
      recordSessions: boolean; // the query log
      dbParams: DbParams;
    }
  | {
      ok: true;
      mode: "KUBERNETES";
      connectorId: string;
      name: string;
      description: string | null;
      targetHost: string; // the API server
      targetPort: number;
      username: string; // the service account, as the admin names it
      secret: SecretInput | null; // its token
      recordSessions: boolean; // the request log and kubectl exec
      keystrokeLogging: boolean;
      kubeParams: KubeParams;
    }
  | {
      ok: true;
      mode: "TUNNEL";
      connectorId: string;
      name: string;
      description: string | null;
      targetHost: string;
      targetPort: number;
    }
  | { ok: false; error: string };

// true/false is a per-resource choice; anything else ("inherit", absent) is null.
function watermarkFrom(body: Record<string, unknown>): boolean | null {
  return body.watermark === true ? true : body.watermark === false ? false : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Validates + normalizes a site create/update body, branching by accessMode. Pure
// (no DB/env) so it is unit-tested; the routes do the DB writes with its output.
export function validateSiteInput(
  body: Record<string, unknown>,
  opts: { nativeGateway: boolean; requireSecret: boolean; recordingEnabled: boolean; isolationEnabled: boolean; hostSuffix?: string | null },
): SiteValidation {
  const connectorId = str(body.connectorId);
  const name = str(body.name);
  const description = str(body.description) || null;
  const mode = body.accessMode === "GATEWAY" ? "GATEWAY" : body.accessMode === "ISOLATED" ? "ISOLATED" : body.accessMode === "DATABASE" ? "DATABASE" : body.accessMode === "TUNNEL" ? "TUNNEL" : body.accessMode === "KUBERNETES" ? "KUBERNETES" : "TRANSPARENT";
  if (!connectorId || !name) return { ok: false, error: "connector_name_required" };

  if (mode === "TUNNEL") {
    // Any TCP service, through the jump host (lib/gateway/tcp-tunnel.ts): no account, nothing recorded.
    if (!opts.nativeGateway) return { ok: false, error: "native_gateway_disabled" };
    const targetHost = str(body.targetHost);
    const targetPort = typeof body.targetPort === "number" ? body.targetPort : Number(str(body.targetPort));
    if (!targetHost || /[\s/]/.test(targetHost)) return { ok: false, error: "tunnel_target_required" };
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return { ok: false, error: "invalid_port" };
    return { ok: true, mode: "TUNNEL", connectorId, name, description, targetHost, targetPort };
  }

  if (mode === "KUBERNETES") {
    if (!opts.nativeGateway) return { ok: false, error: "native_gateway_disabled" };
    const api = parseApiServer(str(body.apiServer) || (str(body.targetHost) && `${str(body.targetHost)}:${str(body.targetPort) || "443"}`));
    if (!api) return { ok: false, error: "invalid_api_server" };
    const username = str(body.username) || "captivo-access";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(username)) return { ok: false, error: "invalid_username" };
    const secret = secretInputFrom(body);
    if (opts.requireSecret && !secret) return { ok: false, error: "kube_token_required" };
    const kubeParams = kubeParamsFrom(body);
    if ("error" in kubeParams) return { ok: false, error: kubeParams.error };
    const recordSessions = opts.recordingEnabled && body.recordSessions === true;
    return {
      ok: true, mode: "KUBERNETES", connectorId, name, description, targetHost: api.host, targetPort: api.port, username, secret,
      recordSessions, keystrokeLogging: recordSessions && body.keystrokeLogging === true, kubeParams,
    };
  }

  if (mode === "DATABASE") {
    if (!opts.nativeGateway) return { ok: false, error: "native_gateway_disabled" };
    const engineName = str(body.engine).toUpperCase() || "POSTGRES";
    const engine = DB_ENGINES.find((e) => e === engineName);
    if (!engine) return { ok: false, error: "invalid_engine" };
    const targetHost = str(body.targetHost);
    const targetPort = typeof body.targetPort === "number" ? body.targetPort : Number(str(body.targetPort));
    const username = str(body.username);
    const secret = secretInputFrom(body);
    if (!targetHost || !username) return { ok: false, error: "remote_desktop_fields_required" };
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return { ok: false, error: "invalid_port" };
    if (opts.requireSecret && !secret) return { ok: false, error: "remote_desktop_fields_required" };
    const dbParams = dbParamsFrom(body, engine);
    if ("error" in dbParams) return { ok: false, error: dbParams.error };
    return {
      ok: true, mode: "DATABASE", connectorId, name, description, engine, targetHost, targetPort, username, secret,
      recordSessions: opts.recordingEnabled && body.recordSessions === true, dbParams,
    };
  }

  if (mode === "ISOLATED") {
    if (!opts.isolationEnabled) return { ok: false, error: "isolation_disabled" };
    const upstreamUrl = str(body.upstreamUrl);
    if (!upstreamUrl) return { ok: false, error: "isolated_url_required" };
    try {
      const u = new URL(upstreamUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "invalid_upstream_url" };
    } catch { return { ok: false, error: "invalid_upstream_url" }; }
    const clip = str(body.clipboardMode);
    const ft = str(body.fileTransferMode);
    if (body.egressMode !== undefined && body.egressMode !== null && body.egressMode !== "inherit" && !isEgressMode(body.egressMode)) return { ok: false, error: "invalid_egress_mode" };
    const egressHosts = body.egressHosts === undefined ? undefined : parseEgressHosts(body.egressHosts);
    if (egressHosts === null) return { ok: false, error: "invalid_egress_hosts" };
    return {
      ok: true, mode: "ISOLATED", connectorId, name, description, upstreamUrl,
      insecureSkipVerify: body.insecureSkipVerify === true,
      recordSessions: opts.recordingEnabled && body.recordSessions === true,
      keystrokeLogging: opts.recordingEnabled && body.recordSessions === true && body.keystrokeLogging === true,
      clipboardMode: CLIP.includes(clip) ? clip : null,
      watermark: watermarkFrom(body),
      fileTransferMode: FT.includes(ft) ? ft : null,
      egressMode: isEgressMode(body.egressMode) ? body.egressMode : body.egressMode === "inherit" ? null : undefined,
      egressHosts,
    };
  }

  if (mode === "GATEWAY") {
    if (!opts.nativeGateway) return { ok: false, error: "native_gateway_disabled" };
    const protocol = str(body.protocol).toUpperCase();
    if (!PROTOCOLS.includes(protocol as (typeof PROTOCOLS)[number])) return { ok: false, error: "invalid_protocol" };
    const targetHost = str(body.targetHost);
    const targetPort = typeof body.targetPort === "number" ? body.targetPort : Number(str(body.targetPort));
    const username = str(body.username);
    const secret = secretInputFrom(body);
    if (!targetHost || !username) return { ok: false, error: "remote_desktop_fields_required" };
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return { ok: false, error: "invalid_port" };
    if (opts.requireSecret && !secret) return { ok: false, error: "remote_desktop_fields_required" };
    return {
      ok: true,
      mode: "GATEWAY",
      connectorId,
      name,
      description,
      protocol: protocol as "RDP" | "SSH" | "VNC",
      targetHost,
      targetPort,
      username,
      secret,
      recordSessions: opts.recordingEnabled && body.recordSessions === true,
      keystrokeLogging: opts.recordingEnabled && body.recordSessions === true && body.keystrokeLogging === true,
      watermark: watermarkFrom(body),
      clipboardMode: CLIP.includes(str(body.clipboardMode)) ? str(body.clipboardMode) : null,
      guacParams: parseGuacParams(body.guacParams),
      nativeRdp: protocol === "RDP" && body.nativeRdp === true,
      nativeSsh: protocol === "SSH" && body.nativeSsh === true,
      requireModerator: body.requireModerator === true,
    };
  }

  // The form sends only the subdomain LABEL; the server owns the suffix
  // (hostSuffix, e.g. ".access.example.com" self-host or "-acme.sites.cloud.captivo.io"
  // in cloud). With a suffix configured, require a single DNS label and append it.
  // Without one (dev/misconfig), accept the value as-is. When the tenant brings
  // their own domain (customDomain: true), the entered value is a full FQDN they
  // own and is used verbatim (no suffix, no DB work here).
  const customDomain = body.customDomain === true;
  const rawHost = str(body.hostname).toLowerCase().trim();
  if (!rawHost) return { ok: false, error: "invalid_hostname" };
  let hostname: string;
  if (customDomain) {
    // a full tenant-owned FQDN: at least two labels, valid DNS chars, not empty labels
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(rawHost)) return { ok: false, error: "invalid_hostname" };
    hostname = rawHost;
  } else if (opts.hostSuffix) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rawHost)) return { ok: false, error: "invalid_hostname" };
    hostname = `${rawHost}${opts.hostSuffix}`;
  } else {
    hostname = rawHost;
  }
  const upstreamUrl = str(body.upstreamUrl);
  if (!upstreamUrl) return { ok: false, error: "connector_name_upstream_required" };
  try {
    const u = new URL(upstreamUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "invalid_upstream_url" };
  } catch {
    return { ok: false, error: "invalid_upstream_url" };
  }
  const clip = str(body.clipboardMode);
  const clipboardMode = CLIP.includes(clip) ? clip : null;
  const ft = str(body.fileTransferMode);
  const recordSessions = opts.recordingEnabled && body.recordSessions === true;
  return {
    ok: true,
    mode: "TRANSPARENT",
    connectorId,
    name,
    hostname,
    customDomain,
    upstreamUrl,
    description,
    insecureSkipVerify: body.insecureSkipVerify === true,
    clipboardMode,
    recordSessions,
    keystrokeLogging: recordSessions && body.keystrokeLogging === true,
    watermark: watermarkFrom(body),
    fileTransferMode: FT.includes(ft) ? ft : null,
  };
}

const ICON_COLORS_OK = ["blue", "violet", "green", "amber", "cyan", "slate"];
const LOGO_BG_OK = ["white", "tint", "none"];

/**
 * The tile fields of a create/update body. A field left out stays as it is;
 * null (or "auto") puts the automatic choice back.
 */
export function appearanceFrom(body: Record<string, unknown>, iconNames: string[]): { iconName?: string | null; iconColor?: string | null; logoBg?: string | null } | { error: string } {
  const out: { iconName?: string | null; iconColor?: string | null; logoBg?: string | null } = {};
  if (body.iconName !== undefined) {
    if (body.iconName === null || body.iconName === "auto") out.iconName = null;
    else if (typeof body.iconName === "string" && iconNames.includes(body.iconName)) out.iconName = body.iconName;
    else return { error: "invalid_icon" };
  }
  if (body.iconColor !== undefined) {
    if (body.iconColor === null) out.iconColor = null;
    else if (typeof body.iconColor === "string" && ICON_COLORS_OK.includes(body.iconColor)) out.iconColor = body.iconColor;
    else return { error: "invalid_icon" };
  }
  if (body.logoBg !== undefined) {
    if (body.logoBg === null) out.logoBg = null;
    else if (typeof body.logoBg === "string" && LOGO_BG_OK.includes(body.logoBg)) out.logoBg = body.logoBg;
    else return { error: "invalid_icon" };
  }
  return out;
}
