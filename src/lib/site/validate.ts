import { isEgressMode, parseEgressHosts, type EgressMode } from "@/lib/isolation/egress";
import { secretInputFrom, type SecretInput } from "@/lib/vault/secret-input";
import { parseGuacParams, type GuacParams } from "@/lib/gateway/guac-params";

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
      guacParams: GuacParams;
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
      fileTransferMode: string;
      egressMode: EgressMode | undefined; // undefined = leave as it is
      egressHosts: string[] | undefined;
    }
  | { ok: false; error: string };

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
  const mode = body.accessMode === "GATEWAY" ? "GATEWAY" : body.accessMode === "ISOLATED" ? "ISOLATED" : "TRANSPARENT";
  if (!connectorId || !name) return { ok: false, error: "connector_name_required" };

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
    if (body.egressMode !== undefined && body.egressMode !== null && !isEgressMode(body.egressMode)) return { ok: false, error: "invalid_egress_mode" };
    const egressHosts = body.egressHosts === undefined ? undefined : parseEgressHosts(body.egressHosts);
    if (egressHosts === null) return { ok: false, error: "invalid_egress_hosts" };
    return {
      ok: true, mode: "ISOLATED", connectorId, name, description, upstreamUrl,
      insecureSkipVerify: body.insecureSkipVerify === true,
      recordSessions: opts.recordingEnabled && body.recordSessions === true,
      keystrokeLogging: opts.recordingEnabled && body.recordSessions === true && body.keystrokeLogging === true,
      clipboardMode: CLIP.includes(clip) ? clip : null,
      watermark: body.watermark === true ? true : body.watermark === false ? false : null,
      fileTransferMode: FT.includes(ft) ? ft : "none",
      egressMode: isEgressMode(body.egressMode) ? body.egressMode : undefined,
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
      guacParams: parseGuacParams(body.guacParams),
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
  };
}
