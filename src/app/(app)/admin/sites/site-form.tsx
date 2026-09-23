"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseGuacParams } from "@/lib/gateway/guac-params";
import { GuacParamsFields, paramsToGuacFields, guacFieldsToParams, type GuacFields } from "@/components/guac-params-fields";
import type { GuacParams } from "@/lib/gateway/guac-params";
import type { KeystrokeMode } from "@/lib/settings/platform";
import { recordToggleLock } from "@/lib/recording/mode";
import { LocalTime } from "@/app/(app)/_shell/local-time";

function errorMessage(code: string | undefined, isEdit: boolean): string {
  switch (code) {
    case "connector_name_upstream_required":
      return "Connector, name, and internal address are required.";
    case "invalid_hostname":
      return "A public hostname is required.";
    case "invalid_upstream_url":
      return "The internal address must be a valid http:// or https:// URL.";
    case "connector_not_found":
      return "Select a valid connector.";
    case "hostname_taken":
      return "That public hostname is already used by another site.";
    case "remote_desktop_fields_required":
      return "Fill protocol, host, port, username, and password.";
    case "invalid_protocol":
      return "Pick a protocol (RDP, SSH, or VNC).";
    case "invalid_port":
      return "Port must be between 1 and 65535.";
    case "native_gateway_disabled":
      return "Remote session gateway is not enabled.";
    case "connector_name_required":
      return "Connector and name are required.";
    case "forbidden":
      return "Admin privileges are required for this action.";
    case "limit_reached":
      return "Your plan's resource limit is reached — contact your platform operator to raise it.";
    default:
      return isEdit ? "Couldn't save the resource, please try again." : "Couldn't create the resource, please try again.";
  }
}

type SiteInitial = {
  id: string;
  connectorId: string;
  name: string;
  hostname: string;
  upstreamUrl: string;
  description: string;
  insecureSkipVerify: boolean;
  recordSessions: boolean;
  keystrokeLogging?: boolean;
  clipboardMode: string | null;
  watermark?: boolean | null;
  fileTransferMode?: string;
  accessMode: "TRANSPARENT" | "GATEWAY" | "ISOLATED";
  hasLogo?: boolean;
  customDomain?: boolean;
  domainVerifiedAt?: string | null;
};

type VerifyResult = { status: "ok" | "missing" | "mismatch" | "undetermined"; expectedIp?: string | null; resolvedIp?: string | null };

// The standard port for each remote-session protocol; pre-filled when the
// protocol changes (the operator can still override it for a non-standard port).
function defaultPort(protocol: string): number {
  return protocol === "SSH" ? 22 : protocol === "VNC" ? 5900 : 3389;
}

export function SiteForm({
  connectors,
  site,
  recordingEnabled = false,
  recordingMode = "per_resource",
  keystrokeMode = "per_resource",
  guacDefaults = {},
  clipboardDefault = "allow",
  watermarkDefault = false,
  nativeGateway = false,
  isolationEnabled = false,
  hostSuffix = null,
  vault,
  onDone,
}: {
  connectors: { id: string; name: string }[];
  site?: SiteInitial;
  recordingEnabled?: boolean;
  recordingMode?: string;
  keystrokeMode?: KeystrokeMode;
  guacDefaults?: GuacParams; // resolved Policy defaults, so "Inherit" shows the effective value
  clipboardDefault?: string; // resolved Policy clipboard default (allow | no_copy | no_paste | none)
  watermarkDefault?: boolean; // resolved Policy watermark default
  nativeGateway?: boolean;
  isolationEnabled?: boolean;
  hostSuffix?: string | null;
  vault?: { protocol: string; targetHost: string; targetPort: number; username: string; hasSecret: boolean; guacParams?: unknown };
  onDone?: () => void;
}) {
  const router = useRouter();
  const [connectorId, setConnectorId] = useState(site?.connectorId ?? connectors[0]?.id ?? "");
  const [name, setName] = useState(site?.name ?? "");
  // The hostname field holds only the subdomain LABEL; the domain suffix is a
  // fixed, server-owned affix. On edit, strip the suffix off the stored full host.
  const suffix = hostSuffix ?? "";
  const [hostname, setHostname] = useState(
    site?.hostname && suffix && site.hostname.endsWith(suffix)
      ? site.hostname.slice(0, -suffix.length)
      : (site?.hostname ?? ""),
  );
  const [customDomain, setCustomDomain] = useState(site?.customDomain ?? false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [upstreamUrl, setUpstreamUrl] = useState(site?.upstreamUrl ?? "");
  const [description, setDescription] = useState(site?.description ?? "");
  const [insecureSkipVerify, setInsecureSkipVerify] = useState(site?.insecureSkipVerify ?? false);
  const [recordSessions, setRecordSessions] = useState(site?.recordSessions ?? false);
  const [keystrokeLogging, setKeystrokeLogging] = useState(site?.keystrokeLogging ?? false);
  const CLIP_LABEL: Record<string, string> = { allow: "Allow copy & paste", no_copy: "Block copy out", no_paste: "Block paste in", none: "Block both" };
  const clipInheritLabel = `Inherit policy (${CLIP_LABEL[clipboardDefault] ?? clipboardDefault})`;
  const [clipboardMode, setClipboardMode] = useState(site?.clipboardMode ?? "inherit");
  const [watermark, setWatermark] = useState<"inherit" | "on" | "off">(
    site?.watermark == null ? "inherit" : site.watermark ? "on" : "off",
  );
  const [fileTransferMode, setFileTransferMode] = useState(site?.fileTransferMode ?? "none");
  const [accessMode, setAccessMode] = useState<"TRANSPARENT" | "GATEWAY" | "ISOLATED">(site?.accessMode ?? "TRANSPARENT");
  // Remote-desktop (GATEWAY) target — seeded from the site's vault credential; the
  // secret is always blank (write-only).
  const [protocol, setProtocol] = useState(vault?.protocol ?? "RDP");
  const [targetHost, setTargetHost] = useState(vault?.targetHost ?? "");
  const [targetPort, setTargetPort] = useState(String(vault?.targetPort ?? 3389));
  const [username, setUsername] = useState(vault?.username ?? "");
  const [secret, setSecret] = useState("");
  const [guac, setGuac] = useState<GuacFields>(paramsToGuacFields(parseGuacParams(vault?.guacParams)));
  // logo: undefined = leave unchanged; null = remove; string = new base64 data URL.
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [logoType, setLogoType] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tenant recording policy can lock this resource's toggle to a fixed value.
  // The submitted value still reflects the resource's own stored preference
  // (recordSessions state, untouched by the lock) so it's preserved if policy
  // later returns to "per resource" — the lock only affects display/runtime.
  const recordLock = recordToggleLock(recordingMode);
  // Effective recording for DISPLAY gating: under a locked policy (required/off) the
  // forced value drives what the UI shows; otherwise the resource's own toggle. The
  // stored/submitted recordSessions is left untouched — policy overrides at runtime.
  const effectiveRecord = recordLock.locked ? (recordLock.forcedValue ?? false) : recordSessions;

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 200 * 1024) {
      setError("The logo must be 200 KB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogo(typeof reader.result === "string" ? reader.result : null);
      setLogoType(file.type);
      setError(null);
    };
    reader.readAsDataURL(file);
  }
  function removeLogo() {
    setLogo(null);
    setLogoType(undefined);
  }
  // Whether to show a logo preview: a freshly-picked one, or the existing one
  // (unless the admin just removed it).
  const showNewLogo = typeof logo === "string";
  const showExistingLogo = logo === undefined && (site?.hasLogo ?? false);

  // Warn when an http:// address points at a port that almost always speaks
  // TLS (e.g. Proxmox 8006). Dialing plain HTTP into a TLS port leaves the
  // request hanging until it times out — a confusing failure to diagnose, so
  // flag it here at config time. Soft warning only; some setups do serve
  // plain HTTP on these ports, so it never blocks saving.
  const tlsPortWarning = (() => {
    try {
      const u = new URL(upstreamUrl.trim());
      const tlsPorts = new Set(["443", "8443", "9443", "10443", "8006", "8007"]);
      if (u.protocol === "http:" && u.port && tlsPorts.has(u.port)) {
        return `Port ${u.port} usually speaks HTTPS. A plain http:// address to a TLS port makes requests hang — did you mean https://${u.host}${u.pathname}?`;
      }
    } catch {
      /* not a full URL yet — nothing to warn about */
    }
    return null;
  })();

  async function verifyDomain() {
    if (!site?.id) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch(`/api/admin/sites/${site.id}/verify-domain`, { method: "POST" });
      const result = await res.json().catch(() => ({}));
      setVerifyResult(res.ok ? result : { status: "undetermined" });
      if (res.ok && result?.status === "ok") router.refresh();
    } catch {
      setVerifyResult({ status: "undetermined" });
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(site ? `/api/admin/sites/${site.id}` : "/api/admin/sites", {
        method: site ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorId,
          name,
          accessMode,
          hostname,
          customDomain,
          upstreamUrl,
          description: description.trim() || undefined,
          insecureSkipVerify,
          recordSessions,
          keystrokeLogging,
          clipboardMode,
          watermark: watermark === "inherit" ? null : watermark === "on",
          fileTransferMode,
          ...(accessMode === "GATEWAY"
            ? { protocol, targetHost, targetPort: Number(targetPort), username, secret, guacParams: guacFieldsToParams(guac) }
            : {}),
          logo,
          logoType,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || (site ? !result?.ok : !result?.id)) {
        setError(errorMessage(result?.error, !!site));
        return;
      }
      if (onDone) {
        onDone();
        router.refresh();
      } else if (site) {
        router.push("/admin/sites");
        router.refresh();
      } else {
        window.location.reload();
      }
    } catch {
      setError(site ? "Couldn't save the resource, please try again." : "Couldn't create the resource, please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="site-connector">
          Connector
        </label>
        <select
          id="site-connector"
          className="select"
          value={connectorId}
          onChange={(e) => setConnectorId(e.target.value)}
          required
        >
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="site-name">
          Resource name
        </label>
        <input
          id="site-name"
          type="text"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g. Internal wiki"
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="site-access-mode">
          Type
        </label>
        <select
          id="site-access-mode"
          className="select"
          value={accessMode}
          onChange={(e) => setAccessMode(e.target.value === "GATEWAY" ? "GATEWAY" : e.target.value === "ISOLATED" ? "ISOLATED" : "TRANSPARENT")}
        >
          <option value="TRANSPARENT">Web app</option>
          {nativeGateway && <option value="GATEWAY">Remote session (RDP / SSH / VNC)</option>}
          {isolationEnabled && <option value="ISOLATED">Isolated browser (Pro)</option>}
        </select>
        <p className="hint">
          {accessMode === "GATEWAY"
            ? "A native RDP/SSH/VNC session, rendered inside Captivo. The vendor never sees the target password."
            : accessMode === "ISOLATED"
            ? "Open an internal web app inside a throwaway browser that runs next to the connector — only its screen reaches the vendor; nothing lands on their device."
            : "Proxy an internal web app; the vendor opens it in their browser."}
        </p>
      </div>
      {accessMode === "TRANSPARENT" && (
      <>
      <div className="field">
        <label className="field-label">Domain</label>
        <div className="view-toggle" role="group" aria-label="Domain type">
          <button
            type="button"
            className={`btn sm ${!customDomain ? "primary" : ""}`}
            aria-pressed={!customDomain}
            onClick={() => setCustomDomain(false)}
          >
            Managed by us
          </button>
          <button
            type="button"
            className={`btn sm ${customDomain ? "primary" : ""}`}
            aria-pressed={customDomain}
            onClick={() => setCustomDomain(true)}
          >
            Bring your own domain
          </button>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="site-hostname">
          Public hostname
        </label>
        {customDomain ? (
          <>
            <input
              id="site-hostname"
              type="text"
              className="input"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="portal.acme.com"
            />
            <p className="hint">
              Point this domain&apos;s DNS <b>A record</b> at this server, then verify it below.
            </p>
            {site?.id && (
              <>
                {site.domainVerifiedAt && (
                  <p className="notice success">Verified <LocalTime iso={new Date(site.domainVerifiedAt).toISOString()} mode="date" />.</p>
                )}
                <button type="button" className="btn sm" onClick={verifyDomain} disabled={verifying}>
                  {verifying ? "Verifying…" : "Verify DNS"}
                </button>
                {verifyResult && (
                  <p
                    className={`notice ${
                      verifyResult.status === "ok" ? "success" : verifyResult.status === "mismatch" ? "warn" : "error"
                    }`}
                    role="status"
                  >
                    {verifyResult.status === "ok" && "Verified — DNS points at this server."}
                    {verifyResult.status === "missing" &&
                      `No A record found for ${hostname}. Point its DNS A record at this server and try again.`}
                    {verifyResult.status === "mismatch" &&
                      `${hostname} resolves to ${verifyResult.resolvedIp ?? "a different address"}, not this server (${verifyResult.expectedIp ?? "unknown"}). Update the A record and try again.`}
                    {verifyResult.status === "undetermined" && "Couldn't check right now — try again shortly."}
                  </p>
                )}
              </>
            )}
          </>
        ) : hostSuffix ? (
          <div className="host-input-row" style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <input
              id="site-hostname"
              type="text"
              className="input"
              style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="wiki"
              aria-describedby="site-hostname-suffix"
            />
            <span id="site-hostname-suffix" className="host-suffix"
              style={{ padding: "0 0.6rem", whiteSpace: "nowrap", opacity: 0.75, borderTopRightRadius: 6, borderBottomRightRadius: 6 }}>
              {hostSuffix}
            </span>
          </div>
        ) : (
          <input
            id="site-hostname"
            type="text"
            className="input"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            required
            placeholder="wiki.access.example.com"
          />
        )}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="site-upstream">
          Internal address
        </label>
        <input
          id="site-upstream"
          type="text"
          className="input"
          value={upstreamUrl}
          onChange={(e) => setUpstreamUrl(e.target.value)}
          required
          placeholder="http://10.0.5.20:8080"
        />
        <p className="hint">
          The real internal address this connector should reach (e.g. <code>http://10.0.5.20:8080</code>).
          It&apos;s stored on your Manager and sent to the connector over the tunnel; the connector dials it
          inside your network. To cap what a connector may reach, set <code>ALLOWED_TARGETS</code> on it.
        </p>
        {tlsPortWarning && (
          <p className="notice warn" role="alert">{tlsPortWarning}</p>
        )}
      </div>
      </>
      )}
      {accessMode === "ISOLATED" && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="site-iso-url">Internal URL</label>
            <input
              id="site-iso-url"
              type="text"
              className="input"
              value={upstreamUrl}
              onChange={(e) => setUpstreamUrl(e.target.value)}
              required
              placeholder="https://wiki.internal"
            />
            <p className="hint">
              The internal web app the throwaway browser opens (e.g. <code>https://wiki.internal</code>). It&apos;s
              reached from the connector&apos;s network, next to the isolated browser.
            </p>
            {tlsPortWarning && <p className="notice warn" role="alert">{tlsPortWarning}</p>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-clipboard-iso">Clipboard</label>
            <select id="site-clipboard-iso" className="select" value={clipboardMode} onChange={(e) => setClipboardMode(e.target.value)}>
              <option value="inherit">{clipInheritLabel}</option>
              <option value="allow">Allow copy &amp; paste</option>
              <option value="no_copy">Block copy out (no exfil)</option>
              <option value="no_paste">Block paste in</option>
              <option value="none">Block both</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-watermark">Screen watermark</label>
            <select id="site-watermark" className="select" value={watermark} onChange={(e) => setWatermark(e.target.value as "inherit" | "on" | "off")}>
              <option value="inherit">Inherit policy ({watermarkDefault ? "On" : "Off"})</option>
              <option value="on">On (email + live clock)</option>
              <option value="off">Off</option>
            </select>
            <span className="hint">Rendered by the isolated browser (KasmVNC) — the vendor&apos;s email and a live clock overlay every screen, visible in any screenshot or photo (deters and attributes leaks).</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-filetransfer">File transfer</label>
            <select id="site-filetransfer" className="select" value={fileTransferMode} onChange={(e) => setFileTransferMode(e.target.value)}>
              <option value="none">Off (no file transfer)</option>
              <option value="allow">Upload &amp; download</option>
              <option value="no_download">Upload only</option>
              <option value="no_upload">Download only</option>
            </select>
            <span className="hint">Move files between the vendor and the isolated browser. Off by default; enforced server-side.</span>
          </div>
        </>
      )}
      {accessMode === "GATEWAY" && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="site-protocol">Protocol</label>
            <select id="site-protocol" className="select" value={protocol} onChange={(e) => { setProtocol(e.target.value); setTargetPort(String(defaultPort(e.target.value))); }}>
              <option value="RDP">RDP</option>
              <option value="SSH">SSH</option>
              <option value="VNC">VNC</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-target-host">Target host</label>
            <input id="site-target-host" type="text" className="input" value={targetHost} onChange={(e) => setTargetHost(e.target.value)} placeholder="10.0.0.5" />
            <p className="hint">The RDP/SSH/VNC host, reachable from the connector&apos;s network.</p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-target-port">Port</label>
            <input id="site-target-port" type="number" className="input" value={targetPort} onChange={(e) => setTargetPort(e.target.value)} placeholder="3389" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-username">Username</label>
            <input id="site-username" type="text" className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Administrator" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="site-secret">Password</label>
            <input id="site-secret" type="password" className="input" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={vault?.hasSecret ? "•••••••• (stored — type to replace)" : "target password"} autoComplete="new-password" />
            <p className="hint">Stored encrypted and injected into the session — the vendor never sees it.</p>
          </div>
          <details className="guac-advanced">
            <summary>Advanced (Guacamole)</summary>
            <p className="hint">Leave a field on <b>Inherit policy</b> to follow the Policy → Guacamole defaults (the effective value is shown in brackets). Anything set here wins for this resource.</p>
            <div className="field">
              <label className="field-label" htmlFor="site-clipboard-gw">Clipboard</label>
              <select id="site-clipboard-gw" className="select" value={clipboardMode} onChange={(e) => setClipboardMode(e.target.value)}>
                <option value="inherit">{clipInheritLabel}</option>
                <option value="allow">Allow copy &amp; paste</option>
                <option value="no_copy">Block copy out (no exfil)</option>
                <option value="no_paste">Block paste in</option>
                <option value="none">Block both</option>
              </select>
              <span className="hint">Enforced by the session engine (guacd) — copy out / paste in are disabled server-side, a real control (not a browser deterrent).</span>
            </div>
            <GuacParamsFields value={guac} onChange={setGuac} protocol={protocol as "RDP" | "SSH" | "VNC"} policy={guacDefaults} />
          </details>
        </>
      )}
      {(accessMode === "TRANSPARENT" || accessMode === "ISOLATED") && (
        <div className="field">
          <label className="field-label">
            <input
              type="checkbox"
              checked={insecureSkipVerify}
              onChange={(e) => setInsecureSkipVerify(e.target.checked)}
            />{" "}
            Allow self-signed certificate (skip TLS verification)
          </label>
          <span className="hint">
            {accessMode === "ISOLATED"
              ? "Only for internal devices you trust — the isolated browser won't verify the target's certificate. Needed for self-signed targets like Proxmox, iDRAC/iLO, or router panels."
              : "Only for internal devices you trust — the certificate on the connector→app leg won't be verified."}
          </span>
        </div>
      )}
      {recordingEnabled && (
        <div className="field">
          <label className="field-label">
            <input
              type="checkbox"
              checked={effectiveRecord}
              disabled={recordLock.locked}
              onChange={(e) => setRecordSessions(e.target.checked)}
            />{" "}
            Record sessions
            {recordLock.locked && <span className="hint"> — Managed by policy: {recordingMode}</span>}
          </label>
          <span className="hint">
            Captures a replayable recording of vendor sessions on this site for audit purposes.
            {accessMode === "GATEWAY"
              ? " The remote-desktop screen is recorded and replayed in the console."
              : " Web sessions are captured with an in-page recorder."}
          </span>
        </div>
      )}
      {recordingEnabled && accessMode === "GATEWAY" && effectiveRecord && keystrokeMode !== "off" && (
        <div className="field">
          <label className="field-label">
            <input
              type="checkbox"
              checked={keystrokeMode === "required" ? true : keystrokeLogging}
              disabled={keystrokeMode === "required"}
              onChange={(e) => setKeystrokeLogging(e.target.checked)}
            />{" "}
            Keystroke timeline
            {keystrokeMode === "required" && <span className="hint"> — required by Policy</span>}
          </label>
          <span className="hint">
            Captures typed input (commands for SSH, text for RDP) as a searchable timeline linked to the recording — click an entry to jump to that moment. Warning: this records typed input, which may include passwords typed into the session.
          </span>
        </div>
      )}
      {recordingEnabled && accessMode === "GATEWAY" && effectiveRecord && keystrokeMode === "off" && (
        <div className="field">
          <span className="hint">Keystroke logging is disabled in Policy.</span>
        </div>
      )}
      {accessMode === "TRANSPARENT" && (
        <div className="field">
          <label className="field-label" htmlFor="site-clipboard">Clipboard</label>
          <select id="site-clipboard" className="select" value={clipboardMode} onChange={(e) => setClipboardMode(e.target.value)}>
            <option value="inherit">{clipInheritLabel}</option>
            <option value="allow">Allow copy &amp; paste</option>
            <option value="no_copy">Block copy out (no exfil)</option>
            <option value="no_paste">Block paste in</option>
            <option value="none">Block both</option>
          </select>
          <span className="hint">Restricts clipboard in the vendor&apos;s browser via an injected script — a deterrent, not a hard control (bypassable if JavaScript is disabled).</span>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor="site-logo">Logo (optional)</label>
        <div className="logo-field">
          {showNewLogo ? (
            <img className="logo-preview" src={logo as string} alt="" />
          ) : showExistingLogo && site ? (
            <img className="logo-preview" src={`/api/sites/${site.id}/logo`} alt="" />
          ) : (
            <span className="logo-preview logo-preview-empty" aria-hidden="true">—</span>
          )}
          <div className="logo-actions">
            <input id="site-logo" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={onLogoFile} />
            {(showNewLogo || showExistingLogo) && (
              <button type="button" className="btn sm" onClick={removeLogo}>Remove</button>
            )}
          </div>
        </div>
        <p className="hint">PNG, JPG, SVG or WebP, up to 200 KB. Sites without a logo show a colored initial.</p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="site-description">
          Description (optional)
        </label>
        <input
          id="site-description"
          type="text"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? "Saving…" : site ? "Save changes" : "Create site"}
      </button>
    </form>
  );
}
