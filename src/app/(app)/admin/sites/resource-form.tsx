"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sealSecret } from "@/lib/vault/seal";
import { parseGuacParams, type GuacParams } from "@/lib/gateway/guac-params";
import { GuacParamsFields } from "@/components/guac-params-fields";
import { paramsToGuacFields, guacFieldsToParams, type GuacFields } from "@/lib/gateway/guac-fields";
import { ResourceIcon } from "@/components/resource-icon";
import { autoIcon, defaultColor, protoLabel, slugFromName, type IconColor, type ResourceKind } from "@/lib/site/icons";
import { recordToggleLock } from "@/lib/recording/mode";
import { compareSemver } from "@/lib/updates/semver";
import { NATIVE_RDP_MIN_CONNECTOR } from "@/lib/gateway/native-rdp";
import { NATIVE_SSH_MIN_CONNECTOR, NATIVE_SSH_RECORDED_MIN_CONNECTOR } from "@/lib/gateway/native-ssh";
import { SshHostKeyLine } from "./ssh-host-key";
import { DATABASE_MIN_CONNECTOR, parseDbParams } from "@/lib/database/params";
import type { KeystrokeMode } from "@/lib/settings/platform";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { IconPicker, lookBody, type Look } from "./icon-picker";

type Kind = "web" | "isolated" | "remote" | "ssh" | "database";
type Probe = { state: "idle" | "busy" | "ok" | "fail"; ms?: number; error?: string };

export interface ResourceContext {
  connectors: { id: string; name: string; online: boolean; vaultPublicKey?: string | null; version?: string | null }[];
  /** Connector groups: a resource on one is served by any eligible member. */
  groups?: ResourceGroup[];
  recordingEnabled: boolean;
  recordingMode: string;
  keystrokeMode: KeystrokeMode;
  guacDefaults: GuacParams;
  clipboardDefault: string;
  watermarkDefault: boolean;
  egressDefault: string;
  fileTransferDefault: string;
  webFileTransferDefault: string;
  nativeGateway: boolean;
  isolationEnabled: boolean;
  /** ".acme.cloud.captivo.io"; null when no domain is configured. */
  hostSuffix: string | null;
  /** The address a custom domain's A record must point to. */
  customDomainIp: string | null;
}

export type ResourceGroup = { id: string; name: string; members: { id: string; name: string; online: boolean; standby: boolean; vaultPublicKey: string | null; version: string | null }[] };

export interface ResourceInitial {
  id: string;
  connectorId: string;
  connectorGroupId?: string | null;
  name: string;
  hostname: string;
  upstreamUrl: string;
  description: string;
  insecureSkipVerify: boolean;
  recordSessions: boolean;
  keystrokeLogging: boolean;
  nativeRdp: boolean;
  nativeSsh: boolean;
  clipboardMode: string | null;
  watermark: boolean | null;
  fileTransferMode: string | null;
  egressMode: string | null;
  egressHosts: string[];
  egressReportOnlyUntil: string | null;
  accessMode: "TRANSPARENT" | "GATEWAY" | "ISOLATED" | "DATABASE";
  hasLogo: boolean;
  customDomain: boolean;
  domainVerifiedAt: string | null;
  iconName: string | null;
  iconColor: string | null;
  logoBg: string | null;
}
export interface VaultMeta { protocol: string; targetHost: string; targetPort: number; username: string; hasSecret: boolean; guacParams?: unknown; dbParams?: unknown; sealed?: boolean; stale?: boolean; sealedKeys?: string[]; sshHostKey?: string | null }
export type EgressEvent = { dest: string; blocked: boolean; reason: string; count: number; last: string };

const KINDS: { kind: Kind; title: string; tag: string; desc: string; icon: string; color: IconColor }[] = [
  { kind: "web", title: "Web app", tag: "HTTP(S)", desc: "Proxy an internal web app; users open it in their own browser.", icon: "globe", color: "blue" },
  { kind: "isolated", title: "Isolated browser", tag: "HTTPS", desc: "The app opens in an isolated browser on the server; no data lands on the device.", icon: "shield", color: "blue" },
  { kind: "remote", title: "Remote desktop", tag: "RDP", desc: "A Windows desktop in the browser; no client install.", icon: "desktop", color: "violet" },
  { kind: "ssh", title: "SSH terminal", tag: "SSH", desc: "A terminal in the browser; credentials are never shown to the user.", icon: "terminal", color: "violet" },
  { kind: "database", title: "Database", tag: "PostgreSQL", desc: "Users connect with their own client (psql, DBeaver); every query is logged.", icon: "database", color: "green" },
];
const DB_TLS: [string, string][] = [["require", "Encrypted"], ["verify-full", "Encrypted + verified"], ["disable", "Off"]];
const CLIP: [string, string][] = [["allow", "Copy & paste"], ["no_copy", "Paste only"], ["no_paste", "Copy only"], ["none", "Block"]];
const FT: [string, string][] = [["allow", "Upload & download"], ["no_download", "Upload only"], ["no_upload", "Download only"], ["none", "Block"]];
const EGRESS: Record<string, string> = { internet: "The resource and the internet", strict: "Only the resource and listed hosts", open: "Unrestricted" };

function errorMessage(code: string | undefined, edit: boolean): string {
  switch (code) {
    case "invalid_hostname": return "Enter a valid public address.";
    case "hostname_taken": return "That public address is already in use.";
    case "invalid_upstream_url": case "connector_name_upstream_required": case "isolated_url_required": return "Enter the internal address as http(s)://host:port.";
    case "connector_not_found": return "Pick a connector.";
    case "remote_desktop_fields_required": return "Enter the internal address, username and password.";
    case "invalid_port": return "The port must be between 1 and 65535.";
    case "native_gateway_disabled": return "Remote desktop and SSH are not enabled on this installation.";
    case "isolation_disabled": return "The isolated browser is not enabled on this installation.";
    case "vault_secret_required": return "Enter the password again: it was encrypted for the previous address, username or connector.";
    case "vault_key_changed": return "The connector's encryption key changed. Reload the page and enter the password again.";
    case "native_with_rotation": return "This resource rotates its password, so nobody knows it to type into a native client. Turn rotation off first.";
    case "invalid_sealed_secret": case "vault_unsupported_browser": return "This browser can't encrypt the password for the connector. Use a current Chrome, Edge, Firefox or Safari.";
    case "invalid_egress_hosts": return "Allowed hosts must be host names (sso.example.local, *.okta.com) or IP addresses, at most 50.";
    case "logo_too_large": return "The logo must be 512 KB or smaller.";
    case "invalid_logo_type": case "invalid_logo": return "Use a PNG, SVG, JPG or WebP logo.";
    case "invalid_database": return "Database names can't have spaces or quotes, at most 63 characters, at most 50 of them.";
    case "invalid_ca_cert": return "Paste the CA certificate in PEM form (-----BEGIN CERTIFICATE-----).";
    case "vault_connector_key_required": return "A database password is sealed to its connector, and this connector has no vault key yet. Update it to 2.46.0 or later.";
    case "limit_reached": return "Your plan's resource limit is reached. Ask your platform operator to raise it.";
    default: return edit ? "Couldn't save the resource. Try again." : "Couldn't add the resource. Try again.";
  }
}

const defaultPort = (p: string) => (p === "SSH" ? 22 : p === "VNC" ? 5900 : p === "POSTGRES" ? 5432 : 3389);
const WEB_RE = /^https?:\/\/[^\s/:]+(:\d{1,5})?(\/\S*)?$/i;
const HOSTPORT_RE = /^(\[[0-9a-f:]+\]|[^\s/:[\]]+)(:\d{1,5})?$/i;

function kindOfInitial(site: ResourceInitial | undefined, vault: VaultMeta | undefined): { kind: Kind; protocol: "RDP" | "VNC" | "SSH" } {
  if (!site) return { kind: "web", protocol: "RDP" };
  if (site.accessMode === "ISOLATED") return { kind: "isolated", protocol: "RDP" };
  if (site.accessMode === "DATABASE") return { kind: "database", protocol: "RDP" };
  if (site.accessMode === "GATEWAY") {
    const p = (vault?.protocol ?? "RDP").toUpperCase();
    return p === "SSH" ? { kind: "ssh", protocol: "SSH" } : { kind: "remote", protocol: p === "VNC" ? "VNC" : "RDP" };
  }
  return { kind: "web", protocol: "RDP" };
}

/** Remote file transfer lives in the engine settings: the four choices on top of them. */
function guacFtMode(g: GuacFields): string {
  if (g.fileTransfer === "") return "inherit";
  if (g.fileTransfer === "off") return "none";
  const up = g.blockUpload === "on", down = g.blockDownload === "on";
  return up && down ? "none" : up ? "no_upload" : down ? "no_download" : "allow";
}
function withGuacFt(g: GuacFields, mode: string): GuacFields {
  switch (mode) {
    case "inherit": return { ...g, fileTransfer: "", blockUpload: "", blockDownload: "" };
    case "none": return { ...g, fileTransfer: "off", blockUpload: "", blockDownload: "" };
    case "allow": return { ...g, fileTransfer: "on", blockUpload: "off", blockDownload: "off" };
    case "no_download": return { ...g, fileTransfer: "on", blockUpload: "off", blockDownload: "on" };
    default: return { ...g, fileTransfer: "on", blockUpload: "on", blockDownload: "off" };
  }
}
function guacPolicyFt(d: GuacParams): string {
  if (!d.enableFileTransfer) return "none";
  return d.blockUpload && d.blockDownload ? "none" : d.blockUpload ? "no_upload" : d.blockDownload ? "no_download" : "allow";
}

export function ResourceForm({ ctx, site, vault, egressEvents, onClose, onSaved }: {
  ctx: ResourceContext;
  site?: ResourceInitial;
  vault?: VaultMeta;
  egressEvents?: EgressEvent[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const router = useRouter();
  const edit = !!site;
  const init = kindOfInitial(site, vault);
  const [kind, setKind] = useState<Kind>(init.kind);
  const [protocol, setProtocol] = useState<"RDP" | "VNC" | "SSH">(init.protocol);
  const [name, setName] = useState(site?.name ?? "");
  const [connectorId, setConnectorId] = useState(site?.connectorId ?? ctx.connectors.find((c) => c.online)?.id ?? ctx.connectors[0]?.id ?? "");
  // A connector group instead of one connector (connectorId then stands for its first member).
  const [groupId, setGroupId] = useState<string | null>(site?.connectorGroupId ?? null);
  // Public address (web only).
  const suffix = ctx.hostSuffix ?? "";
  const [customDomain, setCustomDomain] = useState(site?.customDomain ?? false);
  // The managed label follows the name until it is edited (null = not edited).
  const [labelEdit, setLabelEdit] = useState<string | null>(
    site && !site.customDomain ? (suffix && site.hostname.endsWith(suffix) ? site.hostname.slice(0, -suffix.length) : site.hostname) : null,
  );
  const [domain, setDomain] = useState(site?.customDomain ? site.hostname : "");
  const [hostState, setHostState] = useState<{ host: string; available: boolean } | null>(null);
  // Internal address.
  const [address, setAddress] = useState(
    (site?.accessMode === "GATEWAY" || site?.accessMode === "DATABASE") && vault ? `${vault.targetHost}${vault.targetPort === defaultPort(vault.protocol.toUpperCase()) ? "" : `:${vault.targetPort}`}` : site?.upstreamUrl ?? "",
  );
  const [addrTouched, setAddrTouched] = useState(false);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const [insecure, setInsecure] = useState(site?.insecureSkipVerify ?? false);
  const [username, setUsername] = useState(vault?.username ?? "");
  const [secret, setSecret] = useState("");
  // Session rules.
  const [record, setRecord] = useState(site?.recordSessions ?? false);
  // A new remote desktop or SSH resource logs keystrokes with its recording
  // unless the admin turns it off (null = not chosen yet); a saved one keeps its own.
  const [keystrokeChoice, setKeystrokeChoice] = useState<boolean | null>(site ? site.keystrokeLogging : null);
  const [nativeRdp, setNativeRdp] = useState(site?.nativeRdp ?? false);
  const [nativeSsh, setNativeSsh] = useState(site?.nativeSsh ?? false);
  const [clipboard, setClipboard] = useState(site?.clipboardMode ?? "inherit");
  const [ftWeb, setFtWeb] = useState(site && site.accessMode !== "GATEWAY" ? site.fileTransferMode ?? "inherit" : "inherit");
  const [guac, setGuac] = useState<GuacFields>(paramsToGuacFields(parseGuacParams(vault?.guacParams)));
  const [watermark, setWatermark] = useState<"inherit" | "on" | "off">(site?.watermark == null ? "inherit" : site.watermark ? "on" : "off");
  const [egressMode, setEgressMode] = useState(site?.egressMode ?? "inherit");
  const [egressHosts, setEgressHosts] = useState((site?.egressHosts ?? []).join("\n"));
  // Appearance.
  const initialLook: Look = { iconName: site?.iconName ?? null, iconColor: (site?.iconColor as IconColor) ?? "blue", logoBg: site?.logoBg ?? "white", logo: "keep" };
  const [lookState, setLookState] = useState<Look>(initialLook);
  // The colour follows the type until one is picked (null = not picked).
  const [colorPick, setColorPick] = useState<IconColor | null>((site?.iconColor as IconColor) ?? null);
  // Database resources.
  const initDb = parseDbParams(vault?.dbParams);
  const [dbName, setDbName] = useState(vault?.dbParams ? initDb.database : "");
  const [dbList, setDbList] = useState(initDb.databases.join(", "));
  const [dbTls, setDbTls] = useState<string>(initDb.tls);
  const [dbCa, setDbCa] = useState(initDb.caCertPem ?? "");
  const [description, setDescription] = useState(site?.description ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rkind: ResourceKind = kind === "remote" ? (protocol === "VNC" ? "vnc" : "rdp") : kind;
  const remote = kind === "remote" || kind === "ssh";
  const isDb = kind === "database";
  // A saved account the connector signs in with: remote desktops and databases.
  const cred = remote || isDb;
  const portProto = isDb ? "POSTGRES" : protocol;
  const proto = kind === "ssh" ? "SSH" : kind === "remote" ? protocol : protoLabel(rkind, address.trim());
  const dbNameOk = /^[^\s\0"]{1,63}$/.test(dbName.trim());
  const group = groupId ? (ctx.groups ?? []).find((g) => g.id === groupId) ?? null : null;
  const connector = ctx.connectors.find((c) => c.id === connectorId);
  // The connectors that would carry this resource, and the keys its password is sealed to.
  const routeConnectors = group ? group.members : connector ? [{ ...connector, standby: false, vaultPublicKey: connector.vaultPublicKey ?? null, version: connector.version ?? null }] : [];
  const routeKeys = routeConnectors.map((c) => c.vaultPublicKey).filter((k): k is string => !!k);
  const routeName = group ? group.name : connector?.name;
  const storedLogoUrl = site?.hasLogo ? `/api/sites/${site.id}/logo` : null;
  const autoName = autoIcon(`${name} ${address}`, rkind);
  const look: Look = { ...lookState, iconColor: colorPick ?? defaultColor(rkind) };
  const setLook = (l: Look) => { if (l.iconColor !== look.iconColor) setColorPick(l.iconColor); setLookState(l); };
  const label = labelEdit ?? slugFromName(name);
  const labelOk = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  const domainOk = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain.trim().toLowerCase());
  const publicHost = kind !== "web" ? null : customDomain ? domain.trim().toLowerCase() : label ? `${label}${suffix}` : "";
  // Availability, while typing (debounced).
  useEffect(() => {
    if (kind !== "web") return;
    const valid = customDomain ? domainOk : labelOk;
    if (!valid) return;
    const q = customDomain ? `host=${encodeURIComponent(domain.trim().toLowerCase())}` : `label=${encodeURIComponent(label)}`;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/sites/host-available?${q}${site ? `&except=${site.id}` : ""}`).then((x) => x.json());
        setHostState({ host: r.host, available: !!r.available });
      } catch { setHostState(null); }
    }, 350);
    return () => clearTimeout(t);
  }, [kind, customDomain, label, domain, labelOk, domainOk, site]);

  // Internal address checks.
  const addr = address.trim();
  const addrOk = kind === "web" || kind === "isolated" ? WEB_RE.test(addr) : HOSTPORT_RE.test(addr);
  const hostPort = useMemo(() => {
    const m = HOSTPORT_RE.exec(addr);
    if (!m || !cred) return null;
    const port = m[2] ? Number(m[2].slice(1)) : defaultPort(portProto);
    return { host: m[1].replace(/^\[|\]$/g, ""), port };
  }, [addr, cred, portProto]);
  const https = (kind === "web" || kind === "isolated") && /^https:\/\//i.test(addr);
  const vaultKey = routeKeys[0] ?? null;
  // The saved password still opens where the resource now goes when one of its seals is for a connector there.
  const sealedOpensHere = vault?.sealedKeys ? vault.sealedKeys.some((k) => routeKeys.includes(k)) : site?.connectorId === connectorId && !groupId === !site?.connectorGroupId;
  const sealedTargetChanged = !!vault?.sealed && !!hostPort &&
    (vault.targetHost !== hostPort.host || vault.targetPort !== hostPort.port || vault.username !== username.trim() || !sealedOpensHere);
  // Group members that can't open the saved password (it was sealed before they joined).
  const unsealedMembers = group && vault?.sealed && !secret && vault.sealedKeys ? group.members.filter((m) => !m.vaultPublicKey || !vault.sealedKeys!.includes(m.vaultPublicKey)) : [];
  const needSecret = cred && (!vault || !vault.hasSecret || !!vault.stale || sealedTargetChanged || (isDb && vault.protocol !== "POSTGRES"));

  function pickKind(k: Kind) {
    if (k === kind) return;
    setKind(k);
    if (k === "ssh") setProtocol("SSH");
    else if (k === "remote" && protocol === "SSH") setProtocol("RDP");
    // A new database resource logs its queries unless the admin turns it off.
    if (k === "database" && !edit) setRecord(true);
    setAddress("");
    setAddrTouched(false);
    setProbe({ state: "idle" });
  }
  // A changed target, connector or protocol makes the last probe meaningless.
  const changeAddress = (v: string) => { setAddress(v); setProbe({ state: "idle" }); };
  const changeConnector = (v: string) => { setConnectorId(v); setGroupId(null); setProbe({ state: "idle" }); };
  const changeGroup = (g: ResourceGroup) => {
    const stand = g.members.find((m) => m.online && !m.standby) ?? g.members.find((m) => !m.standby) ?? g.members[0];
    setGroupId(g.id);
    if (stand) setConnectorId(stand.id);
    setProbe({ state: "idle" });
  };
  const changeProtocol = (v: "RDP" | "VNC") => { setProtocol(v); setProbe({ state: "idle" }); };

  async function probeVia(id: string): Promise<{ ok: boolean; ms?: number; error?: string }> {
    try {
      const res = await fetch("/api/admin/sites/probe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: id, target: addr, port: defaultPort(portProto) }),
      });
      const r = await res.json().catch(() => ({}));
      return r.ok ? { ok: true, ms: r.ms } : { ok: false, error: r.error ?? "unreachable" };
    } catch {
      return { ok: false, error: "unreachable" };
    }
  }
  async function runProbe() {
    setProbe({ state: "busy" });
    // A group: through every online member, since any of them may carry a session.
    const via = group ? group.members.filter((m) => m.online) : [{ id: connectorId, name: connector?.name ?? "" }];
    const results = await Promise.all(via.map(async (m) => ({ name: m.name, ...(await probeVia(m.id)) })));
    const ok = results.filter((r) => r.ok);
    if (!group) {
      setProbe(ok.length ? { state: "ok", ms: ok[0].ms } : { state: "fail", error: results[0]?.error ?? "unreachable" });
      return;
    }
    if (results.length === 0) { setProbe({ state: "fail", error: "no member is online" }); return; }
    const each = results.map((r) => (r.ok ? `${r.name} ${r.ms ?? "?"} ms` : `${r.name} ✕`)).join(" · ");
    setProbe(ok.length === results.length ? { state: "ok", ms: undefined, error: each } : ok.length ? { state: "ok", ms: undefined, error: `${each} — sessions skip the members that can't reach it` } : { state: "fail", error: each });
  }

  // What's missing, for the footer.
  const missing: string[] = [];
  if (!name.trim()) missing.push("resource name");
  if (!connectorId && !group) missing.push("connector");
  if (!addrOk) missing.push("internal address");
  if (kind === "web" && !(customDomain ? domainOk : labelOk || !suffix)) missing.push("public address");
  if (kind === "web" && hostState && hostState.host === publicHost && !hostState.available) missing.push("a free public address");
  if (cred && !username.trim()) missing.push("username");
  if (cred && needSecret && !secret) missing.push("password");
  if (isDb && !dbNameOk) missing.push("database name");
  const ready = missing.length === 0 && (kind !== "isolated" || ctx.isolationEnabled) && (!cred || ctx.nativeGateway);
  const kindTitle = KINDS.find((k) => k.kind === kind)!.title;
  const summary = ready
    ? `${kindTitle} · ${publicHost || "only through Captivo"} → ${addr}`
    : `Missing: ${missing.join(", ")}`;

  const recordLock = recordToggleLock(ctx.recordingMode);
  const effRecord = recordLock.locked ? !!recordLock.forcedValue : record;
  const showKeystrokes = ctx.recordingEnabled && effRecord && ctx.keystrokeMode !== "off" && kind !== "database";
  const keystrokes = keystrokeChoice ?? remote;
  const keystrokesOn = showKeystrokes && (ctx.keystrokeMode === "required" || keystrokes);
  // Native RDP: a session in the user's own client can't be recorded. A
  // recorded resource may still offer it (its browser sessions stay recorded);
  // only a Policy that requires recording rules it out.
  const nativeRdpShown = kind === "remote" && protocol === "RDP";
  const nativeRdpLocked = ctx.recordingEnabled && ctx.recordingMode === "required";
  const nativeUnrecorded = ctx.recordingEnabled && effRecord;
  const nativeRdpOn = nativeRdpShown && nativeRdp && !nativeRdpLocked;
  // On a group, native sessions go through members new enough; only all-old is a problem.
  const nativeRdpOldConnector = nativeRdpOn && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, NATIVE_RDP_MIN_CONNECTOR) === -1);
  // Native SSH, through the jump host. On a recorded resource Captivo signs in
  // and records the session (connector 2.49.0); an older connector leaves it
  // unrecorded, or, when the Policy requires recording, unavailable.
  const nativeSshShown = kind === "ssh";
  const nativeSshOn = nativeSshShown && nativeSsh;
  const nativeSshRecorded = nativeUnrecorded || nativeRdpLocked;
  const sshRecordedReady = routeConnectors.length === 0 || routeConnectors.some((c) => compareSemver(c.version, NATIVE_SSH_RECORDED_MIN_CONNECTOR) !== -1);
  const nativeSshOldConnector = nativeSshOn && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, NATIVE_SSH_MIN_CONNECTOR) === -1);
  const nativeSshNeedsUpdate = nativeSshOn && nativeSshRecorded && !sshRecordedReady && !nativeSshOldConnector;
  const dbOldConnector = isDb && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, DATABASE_MIN_CONNECTOR) === -1);
  const ftMode = remote ? guacFtMode(guac) : ftWeb;
  const ftPolicy = remote ? guacPolicyFt(ctx.guacDefaults) : kind === "isolated" ? ctx.fileTransferDefault : ctx.webFileTransferDefault;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let secretBody: Record<string, unknown> = {};
      if (cred && secret && hostPort) {
        try {
          // Sealed in this browser to every connector that may carry the session.
          const target = { host: hostPort.host, port: hostPort.port, username: username.trim() };
          const extra = Object.fromEntries(await Promise.all(routeKeys.slice(1).map(async (k) => [k, await sealSecret(k, secret, target)] as const)));
          secretBody = vaultKey
            ? { sealedSecret: await sealSecret(vaultKey, secret, target), sealedTo: vaultKey, ...(Object.keys(extra).length ? { extraSeals: extra } : {}) }
            : { secret };
        } catch {
          setError(errorMessage("vault_unsupported_browser", edit));
          return;
        }
      }
      const accessMode = kind === "web" ? "TRANSPARENT" : kind === "isolated" ? "ISOLATED" : isDb ? "DATABASE" : "GATEWAY";
      const body: Record<string, unknown> = {
        connectorId, connectorGroupId: groupId ?? undefined, name: name.trim(), accessMode,
        hostname: customDomain ? domain.trim().toLowerCase() : label, customDomain,
        upstreamUrl: cred ? undefined : addr,
        description: description.trim() || undefined,
        insecureSkipVerify: https && insecure,
        recordSessions: record, keystrokeLogging: keystrokes,
        nativeRdp: nativeRdpOn,
        nativeSsh: nativeSshOn,
        clipboardMode: clipboard,
        watermark: watermark === "inherit" ? null : watermark === "on",
        fileTransferMode: remote ? undefined : ftWeb,
        ...(kind === "isolated" ? { egressMode, egressHosts } : {}),
        ...(remote && hostPort ? { protocol, targetHost: hostPort.host, targetPort: hostPort.port, username: username.trim(), ...secretBody, guacParams: guacFieldsToParams(guac) } : {}),
        ...(isDb && hostPort ? { engine: "POSTGRES", targetHost: hostPort.host, targetPort: hostPort.port, username: username.trim(), ...secretBody, database: dbName.trim(), databases: dbList, dbTls, caCertPem: dbTls === "verify-full" ? dbCa : "" } : {}),
        ...lookBody({ ...look, iconColor: colorPick ?? initialLook.iconColor }, initialLook),
      };
      const res = await fetch(site ? `/api/admin/sites/${site.id}` : "/api/admin/sites", {
        method: site ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || (site ? !r?.ok : !r?.id)) { setError(errorMessage(r?.error, edit)); return; }
      // A new resource starts with what the probe saw, instead of "not tested".
      if (!site && r.id && probe.state !== "idle") await fetch(`/api/admin/sites/${r.id}/test`, { method: "POST" }).catch(() => undefined);
      onSaved(edit ? "Resource saved" : "Resource added");
      router.refresh();
    } catch {
      setError(errorMessage(undefined, edit));
    } finally {
      setBusy(false);
    }
  }

  const chips: { text: string; tone: string }[] = [];
  if (effRecord && ctx.recordingEnabled) chips.push({ text: isDb ? "Queries logged" : "Recording on", tone: "bad" });
  if (isDb && dbTls === "disable") chips.push({ text: "No TLS to the server", tone: "warn" });
  if (showKeystrokes) chips.push(keystrokesOn ? { text: "Keystrokes logged", tone: "p" } : { text: "Keystrokes not logged", tone: "warn" });
  if (nativeRdpOn) chips.push({ text: nativeUnrecorded ? "Native RDP: not recorded" : "Native RDP client", tone: "warn" });
  if (nativeSshOn) {
    chips.push(!nativeSshRecorded ? { text: "Native SSH client", tone: "warn" }
      : sshRecordedReady ? { text: "Native SSH: recorded", tone: "p" }
      : { text: nativeRdpLocked ? "Native SSH: connector update needed" : "Native SSH: not recorded", tone: "warn" });
  }
  if (https && insecure) chips.push({ text: "TLS verification off", tone: "warn" });
  if (!isDb && (watermark === "on" || (watermark === "inherit" && ctx.watermarkDefault))) chips.push({ text: "Watermark", tone: "violet" });
  if (!isDb && clipboard !== "inherit") chips.push({ text: `Clipboard: ${CLIP.find(([v]) => v === clipboard)?.[1]}`, tone: "p" });
  if (!isDb && ftMode !== "inherit") chips.push({ text: `Files: ${FT.find(([v]) => v === ftMode)?.[1]}`, tone: "p" });
  const logoUrl = look.logo === "keep" ? storedLogoUrl : look.logo === null ? null : look.logo.previewUrl;
  const tile = <ResourceIcon name={look.iconName ?? autoName} color={look.iconColor} logoUrl={logoUrl} logoBg={look.logoBg} size={42} />;

  return (
    <form className="rf" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
      <div className="rf-body">
        <div className="rf-main">
          <Sec n="01" title={edit ? "Type & connector" : "Type & connector"} />
          <label className="rq-sec">
            <span className="rq-label"><span>Resource name</span><span className="mono t-muted">{name.length}/48</span></span>
            <input className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="e.g. pfSense, Proxmox, Accounting server" autoFocus={!edit} />
          </label>
          <div className="rq-sec">
            <span className="rq-label"><span>Resource type</span></span>
            <div className="rf-kinds" role="radiogroup" aria-label="Resource type">
              {KINDS.map((k) => {
                const off = (k.kind === "isolated" && !ctx.isolationEnabled) || ((k.kind === "remote" || k.kind === "ssh" || k.kind === "database") && !ctx.nativeGateway);
                return (
                  <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} disabled={off} title={off ? "Not enabled on this installation" : undefined}
                    className={kind === k.kind ? "rf-kind on" : "rf-kind"} onClick={() => pickKind(k.kind)}>
                    <ResourceIcon name={k.icon} color={k.color} size={34} />
                    <span className="rf-kind-t"><b>{k.title} <span className="mono">{k.kind === "remote" && kind === "remote" ? protocol : k.tag}</span></b><span className="cell-sub">{k.desc}</span></span>
                  </button>
                );
              })}
            </div>
            {kind === "remote" && (
              <div className="rf-inline">
                <span className="cell-sub">Protocol</span>
                <div className="seg" role="radiogroup" aria-label="Protocol">
                  {(["RDP", "VNC"] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={protocol === p} className={protocol === p ? "seg-opt on" : "seg-opt"} onClick={() => changeProtocol(p)}>{p}</button>)}
                </div>
              </div>
            )}
          </div>
          <div className="rq-sec">
            <span className="rq-label"><span>Connector</span><Link href="/admin/connectors" className="rf-link">+ New connector</Link></span>
            <div className="rf-conns" role="radiogroup" aria-label="Connector">
              {ctx.connectors.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={!groupId && connectorId === c.id} disabled={!c.online && connectorId !== c.id}
                  className={!groupId && connectorId === c.id ? "rf-conn on" : "rf-conn"} onClick={() => changeConnector(c.id)}>
                  <span className="rf-plug" aria-hidden="true"><PlugIcon />{c.online && <span className="rf-plug-dot" />}</span>
                  <span className="rf-conn-t"><b>{c.name}</b><span className="mono t-muted">{c.id.slice(0, 9)} · {c.online ? "online" : "offline"}</span></span>
                  {connectorId === c.id && !groupId && <span className="rf-check" aria-hidden="true">✓</span>}
                </button>
              ))}
              {(ctx.groups ?? []).map((g) => {
                const up = g.members.filter((m) => m.online).length;
                return (
                  <button key={g.id} type="button" role="radio" aria-checked={groupId === g.id} disabled={up === 0 && groupId !== g.id}
                    className={groupId === g.id ? "rf-conn rf-group on" : "rf-conn rf-group"} onClick={() => changeGroup(g)}>
                    <span className="rf-plug" aria-hidden="true"><PlugIcon /><PlugIcon />{up > 0 && <span className="rf-plug-dot" />}</span>
                    <span className="rf-conn-t"><b>{g.name}</b><span className="mono t-muted">group · {g.members.length} connector{g.members.length === 1 ? "" : "s"} · {up} online</span></span>
                    {groupId === g.id && <span className="rf-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
            {group && <p className="rf-hint">Sessions are spread over the online active members ({group.members.filter((m) => !m.standby).map((m) => m.name).join(", ")}){group.members.some((m) => m.standby) ? `; ${group.members.filter((m) => m.standby).map((m) => m.name).join(", ")} take${group.members.filter((m) => m.standby).length === 1 ? "s" : ""} over when none is online` : ""}.</p>}
          </div>

          <Sec n="02" title="Addresses" />
          {kind === "web" ? (
            <div className="rq-sec">
              <span className="rq-label"><span>Public address</span></span>
              <div className="seg rf-seg" role="radiogroup" aria-label="Public address">
                <button type="button" role="radio" aria-checked={!customDomain} className={!customDomain ? "seg-opt on" : "seg-opt"} onClick={() => setCustomDomain(false)}>Captivo domain</button>
                <button type="button" role="radio" aria-checked={customDomain} className={customDomain ? "seg-opt on" : "seg-opt"} onClick={() => setCustomDomain(true)}>Your own domain</button>
              </div>
              {!customDomain ? (
                <>
                  <div className={label && !labelOk ? "rf-host bad" : "rf-host"}>
                    <input className="mono" value={label} onChange={(e) => setLabelEdit(e.target.value.toLowerCase())} aria-label="Address label" placeholder="wiki" />
                    {suffix && <span className="mono t-muted">{suffix}</span>}
                  </div>
                  {label && !labelOk ? <p className="rf-msg bad">Use lowercase letters, digits and hyphens.</p>
                    : hostState && hostState.host === publicHost && !hostState.available ? <p className="rf-msg bad">This address is in use.</p>
                    : label ? <p className="rf-msg ok">✓ https://{publicHost} · TLS certificate is automatic</p> : null}
                </>
              ) : (
                <>
                  <input className={domain && !domainOk ? "input mono bad" : "input mono"} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="wiki.example.com" aria-label="Your domain" />
                  {hostState && hostState.host === publicHost && !hostState.available && <p className="rf-msg bad">This address is in use.</p>}
                  <div className="rf-note">
                    <span>Create this record at your DNS provider; the certificate is issued automatically once it resolves.</span>
                    <code><span className="rf-code-k">A</span> {domain.trim().toLowerCase() || "wiki.example.com"} → {ctx.customDomainIp ?? "this server's address"}</code>
                    {site?.domainVerifiedAt && <span className="t-ok">✓ DNS verified <LocalTime iso={site.domainVerifiedAt} mode="date" /></span>}
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="rf-dotnote"><span aria-hidden="true" />No public address: users reach it through {kind === "isolated" ? "the Captivo portal" : isDb ? "Captivo's database proxy, with a ticket from the portal" : "the Captivo gateway"}.</p>
          )}
          <div className="rq-sec">
            <span className="rq-label"><span>Internal address</span><span className="mono t-muted">{kind === "web" || kind === "isolated" ? "http(s)://ip:port" : `ip:${defaultPort(portProto)}`}</span></span>
            <div className="rf-addr">
              <input className={addrTouched && addr && !addrOk ? "input mono bad" : probe.state === "ok" ? "input mono good" : "input mono"} value={address}
                onChange={(e) => changeAddress(e.target.value)} onBlur={() => setAddrTouched(true)}
                placeholder={kind === "web" || kind === "isolated" ? "http://10.0.5.20:8080" : `10.0.0.2${kind === "ssh" ? ":22" : isDb ? ":5432" : ""}`} aria-label="Internal address" />
              <button type="button" className="btn rf-probe" disabled={!addrOk || !connectorId || probe.state === "busy"} onClick={() => void runProbe()}>
                {probe.state === "busy" ? <span className="rf-spin" aria-hidden="true" /> : <PulseIcon />}Test connection
              </button>
            </div>
            {addrTouched && addr && !addrOk && <p className="rf-msg bad">{kind === "web" || kind === "isolated" ? "Use http(s)://host:port, with an optional path." : "Use host or host:port."}</p>}
            {probe.state === "ok" && <p className="rf-probe-r ok">✓ {group ? "Reached through the group" : "The connector reached the target"}{probe.ms != null ? ` · ${probe.ms} ms` : ""}{group && probe.error ? `: ${probe.error}` : ""}</p>}
            {probe.state === "fail" && <p className="rf-probe-r bad">× {group ? "No member reached this target" : "The connector couldn&apos;t reach this target"} ({probe.error}). Check the address and the firewall.</p>}
            <p className="rf-hint">The connector dials this address from inside your network; it is stored only in the console. To limit what a connector may reach, set <code>ALLOWED_TARGETS</code> on it.</p>
          </div>
          {https && (
            <label className={insecure ? "rf-check-card warn" : "rf-check-card"}>
              <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
              <span><b>Allow a self-signed certificate</b>
                <span className="cell-sub">{insecure ? "Certificate checks are off for this resource. You're not protected against a man in the middle." : "Only for an internal app whose certificate isn't from a public authority."}</span></span>
            </label>
          )}
          {cred && (
            <div className="rf-creds">
              <label className="rq-sec"><span className="rq-label"><span>Username</span></span>
                <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder={kind === "ssh" ? "root" : isDb ? "app_readonly" : "Administrator"} /></label>
              <label className="rq-sec"><span className="rq-label"><span>Password</span></span>
                <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password"
                  placeholder={needSecret ? (vault ? "enter it again" : "") : "saved · leave blank to keep"} /></label>
              <p className="rf-hint rf-wide">Users never see these; {isDb ? "the connector signs in to the database for them" : "the gateway signs in for them"}. The password is {vaultKey ? (group ? "sealed to each connector in the group" : "sealed to the connector") : "stored encrypted"}.{needSecret && vault ? " The saved password was encrypted for the previous address, username or connector, so enter it again." : ""}{isDb ? " What users can do is what this account can do: for read-only access, save an account with only SELECT rights." : ""}</p>
              {!needSecret && unsealedMembers.length > 0 && (
                <p className="rf-msg warn rf-wide">{unsealedMembers.map((m) => m.name).join(", ")} {unsealedMembers.length === 1 ? "has" : "have"} no copy of the saved password yet, so sessions skip {unsealedMembers.length === 1 ? "it" : "them"} for now. A member on 2.44 or later that has it copies it over within a few minutes; entering the password again includes {unsealedMembers.length === 1 ? "it" : "them"} at once.</p>
              )}
            </div>
          )}

          {isDb && (
            <div className="rf-creds">
              <label className="rq-sec"><span className="rq-label"><span>Default database</span></span>
                <input className={dbName && !dbNameOk ? "input mono bad" : "input mono"} value={dbName} onChange={(e) => setDbName(e.target.value)} autoComplete="off" placeholder="crm" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Allowed databases <span className="t-muted rf-opt">(optional)</span></span></span>
                <input className="input mono" value={dbList} onChange={(e) => setDbList(e.target.value)} autoComplete="off" placeholder="any the account can open" /></label>
              <p className="rf-hint rf-wide">A client that names no database lands in the default one. With a list, only those open; without one, any database the account can open.</p>
              <div className="rq-sec rf-wide">
                <span className="rq-label"><span>TLS from the connector to the server</span></span>
                <Pills value={dbTls} onChange={setDbTls} options={DB_TLS} label="TLS to the server" />
                {dbTls === "verify-full" && (
                  <textarea className="textarea mono" rows={3} value={dbCa} onChange={(e) => setDbCa(e.target.value)} placeholder={"-----BEGIN CERTIFICATE-----\n(the server's CA; empty = the system's)"} />
                )}
                <p className="rf-hint">{dbTls === "disable" ? "The connection inside your network is not encrypted; the password is still sent only as the server's sign-in method requires." : dbTls === "require" ? "Encrypted, without checking the server's certificate (fine for a self-signed one inside your network)." : "Encrypted, and the certificate must name this address and chain to the CA."}</p>
              </div>
              {dbOldConnector && <p className="rf-msg bad rf-wide">The connector {connector?.name} runs {connector?.version}; database access needs {DATABASE_MIN_CONNECTOR} or later. Update it before users connect.</p>}
            </div>
          )}

          <Sec n="03" title="Session rules" />
          <p className="rf-sub">Every setting left on “Policy” follows the Policy page.</p>
          {ctx.recordingEnabled && (
            <Row title={isDb ? "Query log" : "Record sessions"} custom={!recordLock.locked && record} desc={recordLock.locked ? `The Policy page sets recording to ${recordLock.forcedValue ? "required" : "off"} for every resource.` : isDb ? "Every statement is kept with its time, duration and row count, on the connector. Results and parameter values are never stored." : kind === "web" ? "Web sessions are recorded with an in-page recorder and can be replayed." : kind === "ssh" ? "Terminal input and output are recorded." : "The session is recorded as video."}>
              <button type="button" role="switch" aria-checked={effRecord} aria-label={isDb ? "Query log" : "Record sessions"} disabled={recordLock.locked} className={effRecord ? "toggle on" : "toggle"} onClick={() => setRecord(!record)}><span /></button>
            </Row>
          )}
          {showKeystrokes && (
            <Row title="Keystroke log" custom={ctx.keystrokeMode !== "required" && keystrokes !== remote} desc={ctx.keystrokeMode === "required" ? "Required by the Policy page." : "Typed text, searchable later; password prompts stay hidden."}>
              <button type="button" role="switch" aria-checked={ctx.keystrokeMode === "required" || keystrokes} aria-label="Keystroke log" disabled={ctx.keystrokeMode === "required"}
                className={ctx.keystrokeMode === "required" || keystrokes ? "toggle on" : "toggle"} onClick={() => setKeystrokeChoice(!keystrokes)}><span /></button>
            </Row>
          )}
          {nativeRdpShown && (
            <Row title="Native RDP client" custom={nativeRdpOn} desc={nativeRdpLocked
              ? "Not available: the Policy page requires every session to be recorded, and a session in the user's own Remote Desktop app can't be."
              : `Users can also download an .rdp file and connect with their own Remote Desktop app. Those sessions aren't recorded or watchable${nativeUnrecorded ? " (sessions opened in the browser still are)" : ""}, and users sign in to the server with their own account.`}>
              <button type="button" role="switch" aria-checked={nativeRdpOn} aria-label="Native RDP client" disabled={nativeRdpLocked} className={nativeRdpOn ? "toggle on" : "toggle"} onClick={() => setNativeRdp(!nativeRdp)}><span /></button>
            </Row>
          )}
          {nativeRdpOldConnector && <p className="rf-msg bad">The connector {connector?.name} runs {connector?.version}; native RDP needs {NATIVE_RDP_MIN_CONNECTOR} or later. Update it before users connect.</p>}
          {nativeSshShown && (
            <Row title="Native SSH client" custom={nativeSshOn} desc={nativeSshRecorded
              ? "Users can also get an ssh command and connect with their own SSH app (OpenSSH, Termius, PuTTY) through Captivo's jump host. Captivo signs them in with the saved account and records the session like one in the browser. Port and agent forwarding are off, and file transfer (sftp, scp) follows the file transfer setting. VS Code Remote-SSH needs port forwarding, so it doesn't work here."
              : "Users can also get an ssh command and connect with their own SSH app (OpenSSH, VS Code, Termius) through Captivo's jump host. Those sessions aren't recorded or watchable, and users sign in to the server with their own account. What they can forward through the server is up to its sshd settings (AllowTcpForwarding)."}>
              <button type="button" role="switch" aria-checked={nativeSshOn} aria-label="Native SSH client" className={nativeSshOn ? "toggle on" : "toggle"} onClick={() => setNativeSsh(!nativeSsh)}><span /></button>
            </Row>
          )}
          {nativeSshNeedsUpdate && <p className="rf-msg bad">Recording sessions in the user&apos;s own SSH app needs connector {NATIVE_SSH_RECORDED_MIN_CONNECTOR} or later; {connector?.name} runs {connector?.version}. {nativeRdpLocked ? "Until it is updated, users can't connect with their own SSH app." : "Until it is updated, those sessions aren't recorded."}</p>}
          {nativeSshShown && site && vault?.sshHostKey && <SshHostKeyLine siteId={site.id} fingerprint={vault.sshHostKey} />}
          {nativeSshOldConnector && <p className="rf-msg bad">The connector {connector?.name} runs {connector?.version}; native SSH needs {NATIVE_SSH_MIN_CONNECTOR} or later. Update it before users connect.</p>}
          {!isDb && (
            <>
          <Row title="Clipboard" custom={clipboard !== "inherit"} desc={remote ? "Enforced by the session engine: copy out and paste in are turned off on the server." : "Applied by a script added to the user's browser; a deterrent, not a hard control."}>
            <Pills value={clipboard} onChange={setClipboard} options={[["inherit", `Policy (${CLIP.find(([v]) => v === ctx.clipboardDefault)?.[1] ?? ctx.clipboardDefault})`], ...CLIP]} label="Clipboard" />
          </Row>
          <Row title="File transfer" custom={ftMode !== "inherit"} desc={kind === "web" ? "Downloads and form uploads are blocked at the proxy; every file is logged. Use the isolated browser for a hard boundary." : kind === "isolated" ? "Files moving between the user and the isolated browser; enforced on the server." : "The file channel of the session (drive or SFTP), enforced by the session engine."}>
            <Pills value={ftMode} onChange={(m) => (remote ? setGuac(withGuacFt(guac, m)) : setFtWeb(m))} options={[["inherit", `Policy (${FT.find(([v]) => v === ftPolicy)?.[1] ?? ftPolicy})`], ...FT]} label="File transfer" />
          </Row>
          <Row title="Screen watermark" custom={watermark !== "inherit"} desc="The user's email and the time are drawn over the session; they show in screenshots and photos.">
            <Pills value={watermark} onChange={(v) => setWatermark(v as "inherit" | "on" | "off")} options={[["inherit", `Policy (${ctx.watermarkDefault ? "On" : "Off"})`], ["on", "On"], ["off", "Off"]]} label="Screen watermark" />
          </Row>
            </>
          )}

          <Sec n="04" title="Appearance" />
          <IconPicker look={look} onChange={setLook} autoName={autoName} storedLogoUrl={storedLogoUrl} name={name} proto={proto} />
          <label className="rq-sec">
            <span className="rq-label"><span>Description <span className="t-muted rf-opt">(optional)</span></span><span className="mono t-muted">{description.length}/120</span></span>
            <textarea className="textarea" rows={2} maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown under the name in the user portal" />
          </label>

          {(kind === "isolated" || remote) && (
            <>
              <button type="button" className="rf-adv-t" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                <span className="mono">05</span> Advanced <span aria-hidden="true">{advanced ? "▾" : "▸"}</span>
              </button>
              {advanced && kind === "isolated" && (
                <div className="rf-adv">
                  <label className="rq-sec"><span className="rq-label"><span>Network access</span></span>
                    <select className="select" value={egressMode} onChange={(e) => setEgressMode(e.target.value)}>
                      <option value="inherit">Policy ({EGRESS[ctx.egressDefault] ?? ctx.egressDefault})</option>
                      {Object.entries(EGRESS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select></label>
                  {site?.egressReportOnlyUntil && egressMode === "inherit" && (
                    <p className="rf-hint">Report only until <LocalTime iso={site.egressReportOnlyUntil} mode="date" />: nothing is blocked yet. <button type="button" className="btn sm" onClick={() => setEgressMode(ctx.egressDefault)}>Enforce now</button></p>
                  )}
                  <label className="rq-sec"><span className="rq-label"><span>Also allow these hosts</span><span className="mono t-muted">one per line</span></span>
                    <textarea className="textarea mono" rows={3} value={egressHosts} onChange={(e) => setEgressHosts(e.target.value)} placeholder={"sso.example.local\n*.okta.com"} /></label>
                  {egressEvents && egressEvents.length > 0 && (
                    <div className="rf-events">
                      <span className="rq-label"><span>Blocked destinations · last 30 days</span></span>
                      {egressEvents.map((e) => <span key={e.dest} className="rf-event"><span className="mono">{e.dest}</span><span className="cell-sub">{e.blocked ? "blocked" : "would be blocked"} · {e.count}× · <LocalTime iso={e.last} /></span></span>)}
                    </div>
                  )}
                </div>
              )}
              {advanced && remote && (
                <div className="rf-adv">
                  <p className="rf-hint">Session engine settings for this resource; empty ones follow the Policy page.</p>
                  <GuacParamsFields value={guac} onChange={setGuac} protocol={protocol} policy={ctx.guacDefaults} />
                </div>
              )}
            </>
          )}
          {error && <p className="notice error" role="alert">{error}</p>}
        </div>

        <aside className="rf-aside">
          <span className="rf-aside-h">Preview · resource card</span>
          <div className="rf-card">
            <div className="rf-card-h">
              {tile}
              <span className="rf-card-t"><b>{name || "New resource"}</b><span className="mono t-muted"><b>{proto}</b> · {publicHost || "Only through Captivo"}</span></span>
              <span className="rf-new">{edit ? "Edit" : "New"}</span>
            </div>
            <div className="rf-route">
              <span className="rf-route-line">
                <span className="rf-dot p" /><span className="rf-line" /><span className="rf-plug sm"><PlugIcon /></span>
                <span className={probe.state === "ok" ? "rf-line ok" : probe.state === "fail" ? "rf-line bad" : "rf-line dim"} />
                <span className={probe.state === "ok" ? "rf-dot ring ok" : probe.state === "fail" ? "rf-dot ring bad" : "rf-dot ring"} />
              </span>
              <span className="rf-route-l"><span><span className="pp-k">Edge</span>Captivo Edge</span><span><span className="pp-k">{group ? "Group" : "Connector"}</span>{routeName ?? "—"}</span><span><span className="pp-k">Target</span><span className="mono">{addr || "—"}</span></span></span>
            </div>
          </div>
          {chips.length > 0 && <div className="rf-chips">{chips.map((c) => <span key={c.text} className={`rf-chip ${c.tone}`}><span aria-hidden="true" />{c.text}</span>)}</div>}
          <span className="rf-aside-h">In the user portal</span>
          <div className="rf-portal">
            <ResourceIcon name={look.iconName ?? autoName} color={look.iconColor} logoUrl={logoUrl} logoBg={look.logoBg} size={44} />
            <span className="rf-portal-t"><b>{name || "New resource"}</b><span className="cell-sub">{description.trim() || "No description"}</span></span>
            <span className="rf-open">{isDb ? "Connect" : "Open"}</span>
          </div>
          <p className="rf-hint">The icon, name and description show in the portal of the people who get access.</p>
        </aside>
      </div>
      <div className="rf-foot">
        <span className={ready ? "rq-status" : "rq-status t-muted"}>{summary}</span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!ready || busy}>{busy ? "Saving…" : edit ? "Save" : "Add resource"}</button>
      </div>
    </form>
  );
}

function Sec({ n, title }: { n: string; title: string }) {
  return <div className="rf-sec"><span className="mono rf-sec-n">{n}</span><span className="mono">{title.toUpperCase()}</span><span className="rf-sec-l" /></div>;
}
function Row({ title, desc, custom, children }: { title: string; desc: string; custom: boolean; children: React.ReactNode }) {
  return (
    <div className="rf-row">
      <span className="rf-row-t"><b>{title}{custom && <span className="pol-chip p">CUSTOM</span>}</b><span className="cell-sub">{desc}</span></span>
      <div className="rf-row-c">{children}</div>
    </div>
  );
}
function Pills({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) {
  return (
    <div className="rf-pills" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "rf-pill on" : "rf-pill"} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}
const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
function PlugIcon() { return <svg {...svgProps} width={15} height={15}><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></svg>; }
function PulseIcon() { return <svg {...svgProps} width={15} height={15}><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>; }
