"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { NATIVE_RDP_MIN_CONNECTOR, NATIVE_RDP_RECORDED_MIN_CONNECTOR } from "@/lib/gateway/native-rdp";
import { NATIVE_SSH_MIN_CONNECTOR, NATIVE_SSH_RECORDED_MIN_CONNECTOR } from "@/lib/gateway/native-ssh";
import { TUNNEL_MIN_CONNECTOR } from "@/lib/gateway/tcp-tunnel";
import { SshHostKeyLine } from "./ssh-host-key";
import { CredentialSource, type CredentialSource as CredentialSourceKind } from "./vault-ref-fields";
import { platformLabel } from "@/lib/connector/platform-label";
import { DB_ENGINES, dbEngineLabel, dbEngineOf, dbMinConnector, parseDbParams, SESSION_USER_ENGINES, SESSION_USER_MIN_CONNECTOR, type DbEngine } from "@/lib/database/params";
import { KUBE_CA_COMMAND, KUBE_TOKEN_COMMAND, KUBERNETES_MIN_CONNECTOR, kubeSetupYaml, parseKubeParams, validGroup, validNamespace, type KubeIdentity } from "@/lib/kubernetes/params";
import { sessionUserSetup } from "@/lib/database/session-user";
import { ELEVATE_BLOCK_TEXT } from "@/lib/vault/elevation";
import { SSH_CA_BLOCK_TEXT } from "@/lib/vault/ssh-ca";
import { CopyButton } from "@/app/(app)/_shell/copy-button";
import type { KeystrokeMode } from "@/lib/settings/platform";
import { LocalTime } from "@/app/(app)/_shell/local-time";
import { IconPicker, lookBody, type Look } from "./icon-picker";

type Kind = "web" | "isolated" | "remote" | "ssh" | "database" | "tunnel" | "kubernetes";
type Probe = { state: "idle" | "busy" | "ok" | "fail"; ms?: number; error?: string };

export interface ResourceContext {
  connectors: { id: string; name: string; online: boolean; vaultPublicKey?: string | null; sshCaPublicKey?: string | null; version?: string | null; platform?: string | null }[];
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
  /** How many people may moderate (Policy roles); nobody moderates their own session. */
  moderators?: number;
}

export type ResourceGroup = { id: string; name: string; members: { id: string; name: string; online: boolean; standby: boolean; vaultPublicKey: string | null; sshCaPublicKey?: string | null; version: string | null; platform?: string | null }[] };

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
  /** A person with an active grant may check the saved password out (lib/vault/checkout.ts). */
  passwordCheckout?: boolean;
  checkoutMaxMinutes?: number;
  /** A session starts only once a moderator admits it (lib/moderation). */
  requireModerator?: boolean;
  clipboardMode: string | null;
  watermark: boolean | null;
  fileTransferMode: string | null;
  egressMode: string | null;
  egressHosts: string[];
  egressReportOnlyUntil: string | null;
  accessMode: "TRANSPARENT" | "GATEWAY" | "ISOLATED" | "DATABASE" | "TUNNEL" | "KUBERNETES";
  /** TUNNEL: the service inside the network. */
  tunnelHost?: string | null;
  tunnelPort?: number | null;
  hasLogo: boolean;
  customDomain: boolean;
  domainVerifiedAt: string | null;
  iconName: string | null;
  iconColor: string | null;
  logoBg: string | null;
}
export interface VaultMeta { protocol: string; targetHost: string; targetPort: number; username: string; hasSecret: boolean; guacParams?: unknown; dbParams?: unknown; kubeParams?: unknown; sealed?: boolean; stale?: boolean; sealedKeys?: string[]; sshHostKey?: string | null; secretSource?: string | null }
export type EgressEvent = { dest: string; blocked: boolean; reason: string; count: number; last: string };

const KINDS: { kind: Kind; title: string; tag: string; desc: string; icon: string; color: IconColor }[] = [
  { kind: "web", title: "Web app", tag: "HTTP(S)", desc: "Proxy an internal web app; users open it in their own browser.", icon: "globe", color: "blue" },
  { kind: "isolated", title: "Isolated browser", tag: "HTTPS", desc: "The app opens in an isolated browser on the server; no data lands on the device.", icon: "shield", color: "blue" },
  { kind: "remote", title: "Remote desktop", tag: "RDP", desc: "A Windows desktop in the browser; no client install.", icon: "desktop", color: "violet" },
  { kind: "ssh", title: "SSH terminal", tag: "SSH", desc: "A terminal in the browser; credentials are never shown to the user.", icon: "terminal", color: "violet" },
  { kind: "database", title: "Database", tag: "SQL", desc: "Users connect with their own client (psql, mysql, SSMS, DBeaver); every query is logged.", icon: "database", color: "green" },
  { kind: "kubernetes", title: "Kubernetes", tag: "K8S", desc: "A cluster for the user's own kubectl, Lens or k9s. Every request is logged; kubectl exec is recorded.", icon: "cube", color: "amber" },
  { kind: "tunnel", title: "TCP tunnel", tag: "TCP", desc: "Any other TCP service (Redis, MongoDB, a vendor's console) for the user's own app, through an ssh port forward. Not recorded.", icon: "plug", color: "cyan" },
];
const KUBE_IDENTITY: [KubeIdentity, string][] = [["impersonate", "Each user, by name"], ["service_account", "The service account"]];
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
    case "connector_platform": return "This connector is installed as a program, so it can't serve remote desktops, SSH or isolated browsers. Pick a connector installed with Docker.";
    case "remote_desktop_fields_required": return "Enter the internal address, username and password.";
    case "invalid_port": return "The port must be between 1 and 65535.";
    case "native_gateway_disabled": return "Remote desktop and SSH are not enabled on this installation.";
    case "isolation_disabled": return "The isolated browser is not enabled on this installation.";
    case "vault_secret_required": return "Enter the password again: it was encrypted for the previous address, username or connector.";
    case "vault_key_changed": return "The connector's encryption key changed. Reload the page and enter the password again.";
    case "native_with_rotation": return "This resource rotates its password, so nobody knows it to type into a native client. Turn rotation off first, or record the resource: Captivo then signs in for the user in their own app.";
    case "invalid_sealed_secret": case "vault_unsupported_browser": return "This browser can't encrypt the password for the connector. Use a current Chrome, Edge, Firefox or Safari.";
    case "invalid_egress_hosts": return "Allowed hosts must be host names (sso.example.local, *.okta.com) or IP addresses, at most 50.";
    case "logo_too_large": return "The logo must be 512 KB or smaller.";
    case "invalid_logo_type": case "invalid_logo": return "Use a PNG, SVG, JPG or WebP logo.";
    case "invalid_database": return "Database names can't have spaces or quotes, at most 63 characters, at most 50 of them.";
    case "invalid_session_role": return "The session role must be a plain role name (letters, digits, _ . $ -), and is for PostgreSQL and MySQL only.";
    case "invalid_ca_cert": return "Paste the CA certificate in PEM form (-----BEGIN CERTIFICATE-----).";
    case "vault_connector_key_required": return "The secret is sealed to its connector, and this connector has no vault key yet. Update the connector.";
    case "elevate_ssh_only": case "elevate_needs_native": case "elevate_needs_recording": case "elevate_needs_account": case "elevate_root": return ELEVATE_BLOCK_TEXT[code];
    case "ssh_ca_ssh_only": case "ssh_ca_needs_native": case "ssh_ca_needs_recording": return SSH_CA_BLOCK_TEXT[code];
    case "tunnel_target_required": return "Enter the service's address as host:port.";
    case "invalid_api_server": return "Enter the API server as host:port, as kubectl cluster-info shows it.";
    case "kube_token_required": return "Paste the service account's token.";
    case "invalid_kube_group": return "Groups are names like captivo-users, at most 20; system: groups can't be used.";
    case "invalid_namespace": return "Namespaces are lowercase names (letters, digits, hyphens), at most 50.";
    case "invalid_server_name": return "The certificate name must be a host name.";
    case "invalid_username": return "The service account name can have letters, digits, dots, hyphens and colons.";
    case "limit_reached": return "Your plan's resource limit is reached. Ask your platform operator to raise it.";
    default: return edit ? "Couldn't save the resource. Try again." : "Couldn't add the resource. Try again.";
  }
}

const defaultPort = (p: string) => (p === "SSH" ? 22 : p === "VNC" ? 5900 : p === "POSTGRES" ? 5432 : p === "MYSQL" ? 3306 : p === "MSSQL" ? 1433 : p === "REDIS" ? 6379 : p === "MONGODB" ? 27017 : p === "KUBERNETES" ? 6443 : 3389);
const WEB_RE = /^https?:\/\/[^\s/:]+(:\d{1,5})?(\/\S*)?$/i;
const HOSTPORT_RE = /^(\[[0-9a-f:]+\]|[^\s/:[\]]+)(:\d{1,5})?$/i;

function kindOfInitial(site: ResourceInitial | undefined, vault: VaultMeta | undefined): { kind: Kind; protocol: "RDP" | "VNC" | "SSH" } {
  if (!site) return { kind: "web", protocol: "RDP" };
  if (site.accessMode === "ISOLATED") return { kind: "isolated", protocol: "RDP" };
  if (site.accessMode === "DATABASE") return { kind: "database", protocol: "RDP" };
  if (site.accessMode === "TUNNEL") return { kind: "tunnel", protocol: "RDP" };
  if (site.accessMode === "KUBERNETES") return { kind: "kubernetes", protocol: "RDP" };
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
    site?.accessMode === "KUBERNETES" && vault ? `${vault.targetHost.includes(":") ? `[${vault.targetHost}]` : vault.targetHost}:${vault.targetPort}`
    : (site?.accessMode === "GATEWAY" || site?.accessMode === "DATABASE") && vault ? `${vault.targetHost}${vault.targetPort === defaultPort(vault.protocol.toUpperCase()) ? "" : `:${vault.targetPort}`}`
    : site?.accessMode === "TUNNEL" && site.tunnelHost ? `${site.tunnelHost.includes(":") ? `[${site.tunnelHost}]` : site.tunnelHost}:${site.tunnelPort}`
    : site?.upstreamUrl ?? "",
  );
  const [addrTouched, setAddrTouched] = useState(false);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const [insecure, setInsecure] = useState(site?.insecureSkipVerify ?? false);
  const [username, setUsername] = useState(vault?.username ?? "");
  const [secret, setSecret] = useState("");
  // Where the credential lives: typed here (kept sealed by Captivo) or in the customer's own vault.
  const [source, setSource] = useState<CredentialSourceKind>((vault?.secretSource as CredentialSourceKind | null | undefined) ?? "local");
  const [refSealText, setRefSealText] = useState<string | null>(null);
  const [refProblemText, setRefProblemText] = useState<string | null>(null);
  const onRef = useCallback((t: string | null, p: string | null) => { setRefSealText(t); setRefProblemText(p); }, []);
  const effSecret = source === "local" ? secret : refSealText ?? "";
  // Session rules.
  const [record, setRecord] = useState(site?.recordSessions ?? false);
  // A new remote desktop or SSH resource logs keystrokes with its recording
  // unless the admin turns it off (null = not chosen yet); a saved one keeps its own.
  const [keystrokeChoice, setKeystrokeChoice] = useState<boolean | null>(site ? site.keystrokeLogging : null);
  const [nativeRdp, setNativeRdp] = useState(site?.nativeRdp ?? false);
  const [nativeSsh, setNativeSsh] = useState(site?.nativeSsh ?? false);
  const [checkout, setCheckout] = useState(site?.passwordCheckout ?? false);
  const [checkoutMinutes, setCheckoutMinutes] = useState(String(site?.checkoutMaxMinutes ?? 240));
  const [moderated, setModerated] = useState(site?.requireModerator ?? false);
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
  const [engine, setEngine] = useState<DbEngine>(dbEngineOf(vault?.protocol));
  const initDb = parseDbParams(vault?.dbParams, engine);
  const [dbName, setDbName] = useState(vault?.dbParams ? initDb.database : "");
  const [dbList, setDbList] = useState(initDb.databases.join(", "));
  const [dbTls, setDbTls] = useState<string>(initDb.tls);
  const [dbCa, setDbCa] = useState(initDb.caCertPem ?? "");
  const [sessionRole, setSessionRole] = useState(initDb.sessionRole);
  // Kubernetes resources.
  const initKube = parseKubeParams(vault?.kubeParams);
  const [kubeCa, setKubeCa] = useState(initKube.caCertPem ?? "");
  const [kubeServerName, setKubeServerName] = useState(initKube.serverName ?? "");
  const [kubeIdentity, setKubeIdentity] = useState<KubeIdentity>(initKube.identity);
  const [kubeGroups, setKubeGroups] = useState(initKube.groups.join(", "));
  const [kubeNamespaces, setKubeNamespaces] = useState(initKube.namespaces.join(", "));
  const [kubeReadOnly, setKubeReadOnly] = useState(initKube.readOnly);
  const [kubePortForward, setKubePortForward] = useState(initKube.portForward);
  const [kubeSetup, setKubeSetup] = useState(false);
  const [description, setDescription] = useState(site?.description ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rkind: ResourceKind = kind === "remote" ? (protocol === "VNC" ? "vnc" : "rdp") : kind;
  const remote = kind === "remote" || kind === "ssh";
  const isDb = kind === "database";
  // A connector installed as a program has no guacd or isolated browser beside it.
  const needsEngines = kind === "remote" || kind === "ssh" || kind === "isolated";
  const isTunnel = kind === "tunnel";
  const isKube = kind === "kubernetes";
  // A saved account the connector signs in with: remote desktops, databases and clusters (a service account's token).
  const cred = remote || isDb || isKube;
  const portProto = isDb ? engine : isKube ? "KUBERNETES" : protocol;
  const proto = kind === "ssh" ? "SSH" : kind === "remote" ? protocol : isDb ? dbEngineLabel(engine) : isTunnel ? "TCP" : isKube ? "K8S" : protoLabel(rkind, address.trim());
  const kubeGroupList = kubeGroups.split(/[\s,]+/).filter(Boolean);
  const kubeNsList = kubeNamespaces.split(/[\s,]+/).filter(Boolean);
  const kubeGroupsOk = kubeGroupList.length <= 20 && kubeGroupList.every(validGroup);
  const kubeNsOk = kubeNsList.length <= 50 && kubeNsList.every(validNamespace);
  const kubeCaOk = !kubeCa.trim() || kubeCa.includes("BEGIN CERTIFICATE");
  const dbNameOk = engine === "REDIS" ? /^\d{0,3}$/.test(dbName.trim()) : /^[^\s\0"]{1,63}$/.test(dbName.trim()) || (engine !== "POSTGRES" && dbName.trim() === "");
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
  // A TCP service has no default port: it is always named.
  const namedPort = Number(/:(\d{1,5})$/.exec(addr)?.[1] ?? 0);
  const addrOk = kind === "web" || kind === "isolated" ? WEB_RE.test(addr) : isTunnel ? HOSTPORT_RE.test(addr) && namedPort >= 1 && namedPort <= 65535 : HOSTPORT_RE.test(addr);
  const hostPort = useMemo(() => {
    const m = HOSTPORT_RE.exec(addr);
    if (!m || !(cred || isTunnel)) return null;
    const port = m[2] ? Number(m[2].slice(1)) : defaultPort(portProto);
    return { host: m[1].replace(/^\[|\]$/g, ""), port };
  }, [addr, cred, isTunnel, portProto]);
  const https = (kind === "web" || kind === "isolated") && /^https:\/\//i.test(addr);
  const vaultKey = routeKeys[0] ?? null;
  // The saved password still opens where the resource now goes when one of its seals is for a connector there.
  const sealedOpensHere = vault?.sealedKeys ? vault.sealedKeys.some((k) => routeKeys.includes(k)) : site?.connectorId === connectorId && !groupId === !site?.connectorGroupId;
  const sealedTargetChanged = !!vault?.sealed && !!hostPort &&
    (vault.targetHost !== hostPort.host || vault.targetPort !== hostPort.port || vault.username !== username.trim() || !sealedOpensHere);
  // Group members that can't open the saved password (it was sealed before they joined).
  const unsealedMembers = group && vault?.sealed && !effSecret && vault.sealedKeys ? group.members.filter((m) => !m.vaultPublicKey || !vault.sealedKeys!.includes(m.vaultPublicKey)) : [];
  const needSecret = cred && (!vault || !vault.hasSecret || !!vault.stale || sealedTargetChanged || (isDb && !(DB_ENGINES as readonly string[]).includes(vault.protocol)) || (isKube && vault.protocol !== "KUBERNETES") || (!isKube && vault.protocol === "KUBERNETES"));

  function pickKind(k: Kind) {
    if (k === kind) return;
    setKind(k);
    if (k === "ssh") setProtocol("SSH");
    else if (k === "remote" && protocol === "SSH") setProtocol("RDP");
    // A new database or cluster logs what it is asked unless the admin turns it off.
    if ((k === "database" || k === "kubernetes") && !edit) setRecord(true);
    if (k === "kubernetes" && !username.trim()) setUsername("captivo-access");
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
  const changeEngine = (v: DbEngine) => { setEngine(v); setProbe({ state: "idle" }); };

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
  if (cred && !username.trim()) missing.push(isKube ? "service account" : "username");
  if (cred && source !== "local" && refProblemText && (needSecret || refSealText !== null || !vault?.secretSource)) missing.push("vault details");
  else if (cred && needSecret && !effSecret) missing.push(source !== "local" ? "vault reference" : isKube ? "token" : "password");
  if (isDb && !dbNameOk) missing.push("database name");
  if (isKube && !kubeCaOk) missing.push("a PEM CA certificate");
  if (isKube && kubeIdentity === "impersonate" && !kubeGroupsOk) missing.push("valid groups");
  if (isKube && !kubeNsOk) missing.push("valid namespaces");
  const ready = missing.length === 0 && (kind !== "isolated" || ctx.isolationEnabled) && (!(cred || isTunnel) || ctx.nativeGateway);
  const kindTitle = KINDS.find((k) => k.kind === kind)!.title;
  const summary = ready
    ? `${kindTitle} · ${publicHost || "only through Captivo"} → ${addr}`
    : `Missing: ${missing.join(", ")}`;

  const recordLock = recordToggleLock(ctx.recordingMode);
  const effRecord = recordLock.locked ? !!recordLock.forcedValue : record;
  const showKeystrokes = ctx.recordingEnabled && effRecord && ctx.keystrokeMode !== "off" && kind !== "database" && !isTunnel;
  // Remote desktops, SSH and clusters (what is typed into kubectl exec) log keystrokes unless turned off.
  const keystrokesDefault = remote || isKube;
  const keystrokes = keystrokeChoice ?? keystrokesDefault;
  const keystrokesOn = showKeystrokes && (ctx.keystrokeMode === "required" || keystrokes);
  // Native RDP, through the RD Gateway. On a recorded resource Captivo signs in
  // and records the session (connector 2.52.0); an older connector leaves it
  // unrecorded, or, when the Policy requires recording, unavailable.
  const nativeRdpShown = kind === "remote" && protocol === "RDP";
  const nativeRdpLocked = ctx.recordingEnabled && ctx.recordingMode === "required";
  const nativeUnrecorded = ctx.recordingEnabled && effRecord;
  const nativeRdpOn = nativeRdpShown && nativeRdp;
  const nativeRdpRecorded = nativeUnrecorded || nativeRdpLocked;
  const rdpRecordedReady = routeConnectors.length === 0 || routeConnectors.some((c) => compareSemver(c.version, NATIVE_RDP_RECORDED_MIN_CONNECTOR) !== -1);
  // On a group, native sessions go through members new enough; only all-old is a problem.
  const nativeRdpOldConnector = nativeRdpOn && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, NATIVE_RDP_MIN_CONNECTOR) === -1);
  const nativeRdpNeedsUpdate = nativeRdpOn && nativeRdpRecorded && !rdpRecordedReady && !nativeRdpOldConnector;
  // Native SSH, through the jump host. On a recorded resource Captivo signs in
  // and records the session (connector 2.49.0); an older connector leaves it
  // unrecorded, or, when the Policy requires recording, unavailable.
  const nativeSshShown = kind === "ssh";
  // A password can be checked out of a remote desktop, SSH or database resource that keeps it itself.
  const checkoutShown = (kind === "remote" || kind === "ssh" || isDb);
  // Four eyes: remote desktop and SSH resources (what a moderator can watch).
  const moderatedShown = kind === "remote" || kind === "ssh";
  const moderatedOn = moderatedShown && moderated;
  const nativeSshOn = nativeSshShown && nativeSsh;
  const nativeSshRecorded = nativeUnrecorded || nativeRdpLocked;
  if (source === "sshca" && !(nativeSshOn && effRecord)) missing.push("Native SSH client and recording (certificates are used there)");
  const sshRecordedReady = routeConnectors.length === 0 || routeConnectors.some((c) => compareSemver(c.version, NATIVE_SSH_RECORDED_MIN_CONNECTOR) !== -1);
  const nativeSshOldConnector = nativeSshOn && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, NATIVE_SSH_MIN_CONNECTOR) === -1);
  const nativeSshNeedsUpdate = nativeSshOn && nativeSshRecorded && !sshRecordedReady && !nativeSshOldConnector;
  // A tunnel opens nowhere while the Policy requires recording: its bytes are the app's own protocol.
  const tunnelLocked = isTunnel && ctx.recordingEnabled && ctx.recordingMode === "required";
  const tunnelOldConnector = isTunnel && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, TUNNEL_MIN_CONNECTOR) === -1);
  const dbOldConnector = isDb && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, dbMinConnector(engine)) === -1);
  const kubeOldConnector = isKube && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, KUBERNETES_MIN_CONNECTOR) === -1);
  const ftMode = remote ? guacFtMode(guac) : ftWeb;
  const ftPolicy = remote ? guacPolicyFt(ctx.guacDefaults) : kind === "isolated" ? ctx.fileTransferDefault : ctx.webFileTransferDefault;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let secretBody: Record<string, unknown> = {};
      if (cred && effSecret && hostPort) {
        try {
          // Sealed in this browser to every connector that may carry the session.
          const target = { host: hostPort.host, port: hostPort.port, username: username.trim() };
          const extra = Object.fromEntries(await Promise.all(routeKeys.slice(1).map(async (k) => [k, await sealSecret(k, effSecret, target)] as const)));
          secretBody = vaultKey
            ? { sealedSecret: await sealSecret(vaultKey, effSecret, target), sealedTo: vaultKey, ...(Object.keys(extra).length ? { extraSeals: extra } : {}), ...(source !== "local" ? { secretSource: source } : {}) }
            : { secret: effSecret };
        } catch {
          setError(errorMessage("vault_unsupported_browser", edit));
          return;
        }
      }
      const accessMode = kind === "web" ? "TRANSPARENT" : kind === "isolated" ? "ISOLATED" : isDb ? "DATABASE" : isTunnel ? "TUNNEL" : isKube ? "KUBERNETES" : "GATEWAY";
      const body: Record<string, unknown> = {
        connectorId, connectorGroupId: groupId ?? undefined, name: name.trim(), accessMode,
        hostname: customDomain ? domain.trim().toLowerCase() : label, customDomain,
        upstreamUrl: cred || isTunnel ? undefined : addr,
        description: description.trim() || undefined,
        insecureSkipVerify: https && insecure,
        recordSessions: record, keystrokeLogging: keystrokes,
        nativeRdp: nativeRdpOn,
        nativeSsh: nativeSshOn,
        ...(checkoutShown ? { passwordCheckout: checkout && !moderatedOn && source === "local" && !(isDb && sessionRole.trim()), checkoutMaxMinutes: Number(checkoutMinutes) } : {}),
        requireModerator: moderatedOn,
        clipboardMode: clipboard,
        watermark: watermark === "inherit" ? null : watermark === "on",
        fileTransferMode: remote ? undefined : ftWeb,
        ...(kind === "isolated" ? { egressMode, egressHosts } : {}),
        ...(remote && hostPort ? { protocol, targetHost: hostPort.host, targetPort: hostPort.port, username: username.trim(), ...secretBody, guacParams: guacFieldsToParams(guac) } : {}),
        ...(isTunnel && hostPort ? { targetHost: hostPort.host, targetPort: hostPort.port } : {}),
        ...(isKube && hostPort ? {
          apiServer: `${hostPort.host.includes(":") ? `[${hostPort.host}]` : hostPort.host}:${hostPort.port}`, username: username.trim(), ...secretBody,
          caCertPem: kubeCa.trim(), serverName: kubeServerName.trim(), kubeIdentity, kubeGroups: kubeGroupList, namespaces: kubeNsList,
          readOnly: kubeReadOnly, portForward: kubePortForward && !kubeReadOnly,
        } : {}),
        ...(isDb && hostPort ? { engine, targetHost: hostPort.host, targetPort: hostPort.port, username: username.trim(), ...secretBody, database: dbName.trim(), databases: dbList, dbTls, caCertPem: dbTls === "verify-full" ? dbCa : "", sessionRole: SESSION_USER_ENGINES.includes(engine) ? sessionRole.trim() : "" } : {}),
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
  if (isTunnel) chips.push(tunnelLocked ? { text: "Blocked: the Policy requires recording", tone: "warn" } : { text: "Not recorded", tone: "warn" });
  else if (effRecord && ctx.recordingEnabled) chips.push({ text: isDb ? "Queries logged" : isKube ? "Requests logged · exec recorded" : "Recording on", tone: "bad" });
  if (isKube) {
    if (kubeReadOnly) chips.push({ text: "Read only", tone: "p" });
    if (kubeNsList.length) chips.push({ text: `Namespaces: ${kubeNsList.slice(0, 3).join(", ")}${kubeNsList.length > 3 ? "…" : ""}`, tone: "p" });
    if (kubePortForward && !kubeReadOnly) chips.push({ text: "Port forwarding", tone: "warn" });
    chips.push(kubeIdentity === "impersonate" ? { text: "Acts as each user", tone: "p" } : { text: "Acts as the service account", tone: "warn" });
  }
  if (isDb && dbTls === "disable") chips.push({ text: "No TLS to the server", tone: "warn" });
  if (showKeystrokes) chips.push(keystrokesOn ? { text: "Keystrokes logged", tone: "p" } : { text: "Keystrokes not logged", tone: "warn" });
  if (nativeRdpOn) {
    chips.push(!nativeRdpRecorded ? { text: "Native RDP client", tone: "warn" }
      : rdpRecordedReady ? { text: "Native RDP: recorded", tone: "p" }
      : { text: nativeRdpLocked ? "Native RDP: connector update needed" : "Native RDP: not recorded", tone: "warn" });
  }
  if (nativeSshOn) {
    chips.push(!nativeSshRecorded ? { text: "Native SSH client", tone: "warn" }
      : sshRecordedReady ? { text: "Native SSH: recorded", tone: "p" }
      : { text: nativeRdpLocked ? "Native SSH: connector update needed" : "Native SSH: not recorded", tone: "warn" });
  }
  if (moderatedOn) chips.push({ text: "Moderator required", tone: "warn" });
  if (https && insecure) chips.push({ text: "TLS verification off", tone: "warn" });
  if (!isDb && !isTunnel && !isKube && (watermark === "on" || (watermark === "inherit" && ctx.watermarkDefault))) chips.push({ text: "Watermark", tone: "violet" });
  if (!isDb && !isTunnel && !isKube && clipboard !== "inherit") chips.push({ text: `Clipboard: ${CLIP.find(([v]) => v === clipboard)?.[1]}`, tone: "p" });
  if (!isDb && !isTunnel && !isKube && ftMode !== "inherit") chips.push({ text: `Files: ${FT.find(([v]) => v === ftMode)?.[1]}`, tone: "p" });
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
                const off = (k.kind === "isolated" && !ctx.isolationEnabled) || ((k.kind === "remote" || k.kind === "ssh" || k.kind === "database" || k.kind === "tunnel" || k.kind === "kubernetes") && !ctx.nativeGateway);
                return (
                  <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} disabled={off} title={off ? "Not enabled on this installation" : undefined}
                    className={kind === k.kind ? "rf-kind on" : "rf-kind"} onClick={() => pickKind(k.kind)}>
                    <ResourceIcon name={k.icon} color={k.color} size={34} />
                    <span className="rf-kind-t"><b>{k.title} <span className="mono">{k.kind === "remote" && kind === "remote" ? protocol : k.kind === "database" && kind === "database" ? dbEngineLabel(engine) : k.tag}</span></b><span className="cell-sub">{k.desc}</span></span>
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
            {kind === "database" && (
              <div className="rf-inline">
                <span className="cell-sub">Engine</span>
                <div className="seg wrap" role="radiogroup" aria-label="Engine">
                  {DB_ENGINES.map((e) => <button key={e} type="button" role="radio" aria-checked={engine === e} className={engine === e ? "seg-opt on" : "seg-opt"} onClick={() => changeEngine(e)}>{e === "MYSQL" ? "MySQL / MariaDB" : dbEngineLabel(e)}</button>)}
                </div>
              </div>
            )}
          </div>
          <div className="rq-sec">
            <span className="rq-label"><span>Connector</span><Link href="/admin/connectors" className="rf-link">+ New connector</Link></span>
            <div className="rf-conns" role="radiogroup" aria-label="Connector">
              {ctx.connectors.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={!groupId && connectorId === c.id} disabled={(!c.online && connectorId !== c.id) || (needsEngines && !!c.platform)} title={needsEngines && c.platform ? `Installed as a program (${platformLabel(c.platform)}): it serves web apps, databases, clusters and TCP tunnels, not ${kind === "isolated" ? "isolated browsers" : "remote desktops"}.` : undefined}
                  className={!groupId && connectorId === c.id ? "rf-conn on" : "rf-conn"} onClick={() => changeConnector(c.id)}>
                  <span className="rf-plug" aria-hidden="true"><PlugIcon />{c.online && <span className="rf-plug-dot" />}</span>
                  <span className="rf-conn-t"><b>{c.name}</b><span className="mono t-muted">{c.id.slice(0, 9)} · {c.online ? "online" : "offline"}{c.platform ? ` · ${platformLabel(c.platform)}` : ""}</span></span>
                  {connectorId === c.id && !groupId && <span className="rf-check" aria-hidden="true">✓</span>}
                </button>
              ))}
              {(ctx.groups ?? []).map((g) => {
                const up = g.members.filter((m) => m.online).length;
                return (
                  <button key={g.id} type="button" role="radio" aria-checked={groupId === g.id} disabled={(up === 0 && groupId !== g.id) || (needsEngines && g.members.some((m) => !!m.platform))}
                    className={groupId === g.id ? "rf-conn rf-group on" : "rf-conn rf-group"} onClick={() => changeGroup(g)}>
                    <span className="rf-plug" aria-hidden="true"><PlugIcon /><PlugIcon />{up > 0 && <span className="rf-plug-dot" />}</span>
                    <span className="rf-conn-t"><b>{g.name}</b><span className="mono t-muted">group · {g.members.length} connector{g.members.length === 1 ? "" : "s"} · {up} online</span></span>
                    {groupId === g.id && <span className="rf-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
            {needsEngines && (group ? group.members.some((m) => !!m.platform) : !!connector?.platform) && (
              <p className="rf-msg warn">{group ? "A connector in this group" : connector?.name} is installed as a program, with no remote-desktop or isolated-browser engine beside it. Pick a connector installed with Docker for this kind of resource.</p>
            )}
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
            <p className="rf-dotnote"><span aria-hidden="true" />No public address: users reach it through {kind === "isolated" ? "the Captivo portal" : isDb ? "Captivo's database proxy, with a ticket from the portal" : isTunnel ? "an ssh port forward on Captivo's jump host, with a command from the portal" : isKube ? "Captivo's Kubernetes proxy on this console's address, with a kubeconfig from the portal" : "the Captivo gateway"}.</p>
          )}
          <div className="rq-sec">
            <span className="rq-label"><span>{isKube ? "API server" : "Internal address"}</span><span className="mono t-muted">{kind === "web" || kind === "isolated" ? "http(s)://ip:port" : isTunnel ? "host:port" : `ip:${defaultPort(portProto)}`}</span></span>
            <div className="rf-addr">
              <input className={addrTouched && addr && !addrOk ? "input mono bad" : probe.state === "ok" ? "input mono good" : "input mono"} value={address}
                onChange={(e) => changeAddress(e.target.value)} onBlur={() => setAddrTouched(true)}
                placeholder={kind === "web" || kind === "isolated" ? "http://10.0.5.20:8080" : isTunnel ? "10.0.0.2:6379" : isKube ? "10.0.0.5:6443" : `10.0.0.2${kind === "ssh" ? ":22" : isDb ? `:${defaultPort(engine)}` : ""}`} aria-label={isKube ? "API server" : "Internal address"} />
              <button type="button" className="btn rf-probe" disabled={!addrOk || !connectorId || probe.state === "busy"} onClick={() => void runProbe()}>
                {probe.state === "busy" ? <span className="rf-spin" aria-hidden="true" /> : <PulseIcon />}Test connection
              </button>
            </div>
            {addrTouched && addr && !addrOk && <p className="rf-msg bad">{kind === "web" || kind === "isolated" ? "Use http(s)://host:port, with an optional path." : isTunnel ? "Use host:port, with the service's port." : "Use host or host:port."}</p>}
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
          {isKube && (
            <div className="rq-sec">
              <button type="button" className="rf-adv-t" aria-expanded={kubeSetup} onClick={() => setKubeSetup(!kubeSetup)}>
                Set up the cluster <span aria-hidden="true">{kubeSetup ? "▾" : "▸"}</span>
              </button>
              {kubeSetup && (
                <div className="rf-kube-setup">
                  <p className="rf-hint">Apply this once with an admin&apos;s kubectl. It makes a <span className="mono">captivo-access</span> service account{kubeIdentity === "impersonate" ? ` that may act as Captivo users in the groups below, and gives the ${kubeGroupList[0] ?? "captivo-users"} group the built-in "${kubeReadOnly ? "view" : "edit"}" role` : ` with the built-in "${kubeReadOnly ? "view" : "edit"}" role`}. Narrow the roles as you like.</p>
                  <div className="rf-code"><pre className="mono">{kubeSetupYaml({ identity: kubeIdentity, groups: kubeGroupList, readOnly: kubeReadOnly })}</pre><CopyButton value={kubeSetupYaml({ identity: kubeIdentity, groups: kubeGroupList, readOnly: kubeReadOnly })} /></div>
                  <p className="rf-hint">Save it as captivo.yaml and run <code>kubectl apply -f captivo.yaml</code>. Then read the token and the CA:</p>
                  <div className="rf-code"><pre className="mono">{KUBE_TOKEN_COMMAND}</pre><CopyButton value={KUBE_TOKEN_COMMAND} /></div>
                  <div className="rf-code"><pre className="mono">{KUBE_CA_COMMAND}</pre><CopyButton value={KUBE_CA_COMMAND} /></div>
                </div>
              )}
            </div>
          )}
          {cred && (
            <div className="rf-creds">
              <label className="rq-sec"><span className="rq-label"><span>{isKube ? "Service account" : "Username"}</span></span>
                <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder={kind === "ssh" ? "root" : isDb ? "app_readonly" : isKube ? "captivo-access" : "Administrator"} /></label>
              {vaultKey && <CredentialSource source={source} onSource={setSource} saved={!!vault?.secretSource && vault.secretSource === source} onRef={onRef} ssh={kind === "ssh"} caKeys={routeConnectors.map((c) => ({ name: c.name, key: c.sshCaPublicKey ?? null }))} />}
              {source === "local" && <label className="rq-sec"><span className="rq-label"><span>{isKube ? "Token" : "Password"}</span></span>
                <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password"
                  placeholder={needSecret ? (vault ? "enter it again" : "") : "saved · leave blank to keep"} /></label>}
              {isKube ? (
                <p className="rf-hint rf-wide">Users never see the token; the connector signs every request in with it. It is {vaultKey ? (group ? "sealed to each connector in the group" : "sealed to the connector") : "stored encrypted"}.{needSecret && vault ? " The saved token was encrypted for the previous address, account or connector, so paste it again." : ""}</p>
              ) : (
              <p className="rf-hint rf-wide">Users never see these; {isDb ? "the connector signs in to the database for them" : "the gateway signs in for them"}. The password is {vaultKey ? (group ? "sealed to each connector in the group" : "sealed to the connector") : "stored encrypted"}.{needSecret && vault ? " The saved password was encrypted for the previous address, username or connector, so enter it again." : ""}{isDb ? ` What users can do is what this account can do: for read-only access, save an account ${engine === "REDIS" ? "whose ACL allows only read commands (+@read)" : engine === "MONGODB" ? "that has only the read role" : "with only SELECT rights"}.` : ""}</p>
              )}
              {!needSecret && unsealedMembers.length > 0 && (
                <p className="rf-msg warn rf-wide">{unsealedMembers.map((m) => m.name).join(", ")} {unsealedMembers.length === 1 ? "has" : "have"} no copy of the saved password yet, so sessions skip {unsealedMembers.length === 1 ? "it" : "them"} for now. A member on 2.44 or later that has it copies it over within a few minutes; entering the password again includes {unsealedMembers.length === 1 ? "it" : "them"} at once.</p>
              )}
            </div>
          )}

          {isDb && (
            <div className="rf-creds">
              <label className="rq-sec"><span className="rq-label"><span>{engine === "REDIS" ? "Database number" : engine === "MONGODB" ? "Authentication database" : "Default database"}{engine !== "POSTGRES" && <span className="t-muted rf-opt"> (optional)</span>}</span></span>
                <input className={dbName && !dbNameOk ? "input mono bad" : "input mono"} value={dbName} onChange={(e) => setDbName(e.target.value)} autoComplete="off" placeholder={engine === "REDIS" ? "0" : engine === "MONGODB" ? "admin" : "crm"} inputMode={engine === "REDIS" ? "numeric" : undefined} /></label>
              {engine === "REDIS" ? (
                <p className="rf-hint rf-wide">Redis has no per-account databases: a connection starts in this one (SELECT), and a client can SELECT another. What the account may touch is set by its ACL on the server, so give it only the keys and commands users need. CONFIG, MONITOR, replication and ACL changes are refused by the proxy.</p>
              ) : engine === "MONGODB" ? (
                <p className="rf-hint rf-wide">The database the account was created in (admin when empty). A command can name any database the account has a role in, so limit what users reach with the account&apos;s roles. Users and roles can&apos;t be managed through Captivo.</p>
              ) : engine === "MSSQL" ? (
                <p className="rf-hint rf-wide">A client that names no database lands in the default one, or in the login&apos;s own. A statement can name any database the login can open (crm.dbo.orders), so to limit which ones users reach, map the login only to those. Use a SQL Server login: Windows and Entra ID sign-in are not supported.</p>
              ) : engine === "MYSQL" ? (
                <p className="rf-hint rf-wide">A client that names no database lands in the default one, or in none. A statement can name any database the account can open (crm.orders), so to limit which ones users reach, grant the account only those.</p>
              ) : (
                <>
                  <label className="rq-sec"><span className="rq-label"><span>Allowed databases <span className="t-muted rf-opt">(optional)</span></span></span>
                    <input className="input mono" value={dbList} onChange={(e) => setDbList(e.target.value)} autoComplete="off" placeholder="any the account can open" /></label>
                  <p className="rf-hint rf-wide">A client that names no database lands in the default one. With a list, only those open; without one, any database the account can open.</p>
                </>
              )}
              {SESSION_USER_ENGINES.includes(engine) && (
                <div className="rq-sec rf-wide">
                  <label className="rq-sec"><span className="rq-label"><span>Session role <span className="t-muted rf-opt">(optional)</span></span></span>
                    <input className="input mono" value={sessionRole} onChange={(e) => setSessionRole(e.target.value)} autoComplete="off" placeholder="app_readonly" /></label>
                  <p className="rf-hint">{sessionRole.trim()
                    ? <>Each connection gets its own database user, made just before it opens and dropped when it closes. The user has only what <span className="mono">{sessionRole.trim()}</span> has; the account above only provisions it and is never used by anyone. Needs connector {SESSION_USER_MIN_CONNECTOR} or later.</>
                    : "Leave empty to sign everyone in as the account above. With a role, every connection works as a short-lived user of its own, so no standing account is used."}</p>
                  {sessionRole.trim() && (
                    <div className="rf-code"><pre className="mono">{sessionUserSetup(engine, sessionRole.trim(), username.trim() || "captivo_provisioner")}</pre><CopyButton value={sessionUserSetup(engine, sessionRole.trim(), username.trim() || "captivo_provisioner")} /></div>
                  )}
                </div>
              )}
              <div className="rq-sec rf-wide">
                <span className="rq-label"><span>TLS from the connector to the server</span></span>
                <Pills value={dbTls} onChange={setDbTls} options={DB_TLS} label="TLS to the server" />
                {dbTls === "verify-full" && (
                  <textarea className="textarea mono" rows={3} value={dbCa} onChange={(e) => setDbCa(e.target.value)} placeholder={"-----BEGIN CERTIFICATE-----\n(the server's CA; empty = the system's)"} />
                )}
                <p className="rf-hint">{dbTls === "disable" ? (engine === "REDIS" ? "A plain connection to the server's regular port; the password crosses your network in the clear." : engine === "MSSQL" ? "Only the sign-in is encrypted (SQL Server's minimum); queries and results cross your network in the clear, unless the server forces encryption." : "The connection inside your network is not encrypted; the password is still sent only as the server's sign-in method requires.") : dbTls === "require" ? "Encrypted, without checking the server's certificate (fine for a self-signed one inside your network)." : "Encrypted, and the certificate must name this address and chain to the CA."}</p>
              </div>
              {isDb && sessionRole.trim() && routeConnectors.length > 0 && routeConnectors.every((c) => compareSemver(c.version, SESSION_USER_MIN_CONNECTOR) === -1) && <p className="rf-msg bad rf-wide">The connector {connector?.name} runs {connector?.version}; a user per connection needs {SESSION_USER_MIN_CONNECTOR} or later.</p>}
              {dbOldConnector && <p className="rf-msg bad rf-wide">The connector {connector?.name} runs {connector?.version}; {dbEngineLabel(engine)} access needs {dbMinConnector(engine)} or later. Update it before users connect.</p>}
            </div>
          )}

          {isKube && (
            <div className="rf-creds">
              <label className="rq-sec rf-wide"><span className="rq-label"><span>Cluster CA certificate <span className="t-muted rf-opt">(empty = a public certificate)</span></span></span>
                <textarea className={kubeCaOk ? "textarea mono" : "textarea mono bad"} rows={3} value={kubeCa} onChange={(e) => setKubeCa(e.target.value)} placeholder={"-----BEGIN CERTIFICATE-----\n(the ca.crt from the token's Secret)"} /></label>
              <label className="rq-sec"><span className="rq-label"><span>Certificate name <span className="t-muted rf-opt">(optional)</span></span></span>
                <input className="input mono" value={kubeServerName} onChange={(e) => setKubeServerName(e.target.value)} autoComplete="off" placeholder="kubernetes.default" /></label>
              <p className="rf-hint">Only when the API server&apos;s certificate doesn&apos;t name the address above.</p>
              <div className="rq-sec rf-wide">
                <span className="rq-label"><span>Requests act as</span></span>
                <Pills value={kubeIdentity} onChange={(v) => setKubeIdentity(v as KubeIdentity)} options={KUBE_IDENTITY} label="Requests act as" />
                <p className="rf-hint">{kubeIdentity === "impersonate"
                  ? "Each request acts as the Captivo user's e-mail address in the groups below, so the cluster's roles and audit log see the person. The service account needs the right to impersonate (the setup above gives it)."
                  : "Every request acts as the service account itself, so the cluster's audit log shows one account; Captivo's request log still names the person."}</p>
              </div>
              {kubeIdentity === "impersonate" && (
                <label className="rq-sec rf-wide"><span className="rq-label"><span>Groups</span></span>
                  <input className={kubeGroupsOk ? "input mono" : "input mono bad"} value={kubeGroups} onChange={(e) => setKubeGroups(e.target.value)} autoComplete="off" placeholder="captivo-users" /></label>
              )}
              <label className="rq-sec rf-wide"><span className="rq-label"><span>Namespaces <span className="t-muted rf-opt">(optional)</span></span></span>
                <input className={kubeNsOk ? "input mono" : "input mono bad"} value={kubeNamespaces} onChange={(e) => setKubeNamespaces(e.target.value)} autoComplete="off" placeholder="all namespaces" /></label>
              <p className="rf-hint rf-wide">With a list, Captivo refuses requests for any other namespace and anything across all of them; cluster-wide objects (nodes, namespaces) can still be read, never changed.</p>
              {kubeOldConnector && <p className="rf-msg bad rf-wide">The connector {connector?.name} runs {connector?.version}; Kubernetes access needs {KUBERNETES_MIN_CONNECTOR} or later. Update it before users connect.</p>}
            </div>
          )}

          <Sec n="03" title="Session rules" />
          <p className="rf-sub">Every setting left on “Policy” follows the Policy page.</p>
          {isTunnel && (
            <div className="rf-row">
              <span className="rf-row-t"><b>Not recorded</b><span className="cell-sub">The tunnel carries the app&apos;s own protocol, so Captivo can&apos;t record or watch it. The audit log keeps who connected, when, for how long and how much data moved. Access is checked again every minute, and an admin can end the tunnel from Live sessions.</span></span>
            </div>
          )}
          {tunnelLocked && <p className="rf-msg bad">The Policy page requires every session to be recorded, so users can&apos;t open this tunnel until that changes.</p>}
          {tunnelOldConnector && <p className="rf-msg bad">The connector {connector?.name} runs {connector?.version}; TCP tunnels need {TUNNEL_MIN_CONNECTOR} or later. Update it before users connect.</p>}
          {ctx.recordingEnabled && !isTunnel && (
            <Row title={isDb ? "Query log" : isKube ? "Request log and exec recording" : "Record sessions"} custom={!recordLock.locked && record} desc={recordLock.locked ? `The Policy page sets recording to ${recordLock.forcedValue ? "required" : "off"} for every resource.` : isDb ? (engine === "REDIS" || engine === "MONGODB" ? "Every command is kept with its time and duration, on the connector, with its first argument (Redis) or collection (MongoDB). Values, filters, documents and results are never stored." : "Every statement is kept with its time, duration and row count, on the connector. Results and parameter values are never stored.") : isKube ? "Every request is kept with its verb, resource, namespace and result, on the connector; request bodies and what secrets hold are never stored. kubectl exec and attach are recorded as terminals and can be watched live." : kind === "web" ? "Web sessions are recorded with an in-page recorder and can be replayed." : kind === "ssh" ? "Terminal input and output are recorded." : "The session is recorded as video."}>
              <button type="button" role="switch" aria-checked={effRecord} aria-label={isDb ? "Query log" : isKube ? "Request log and exec recording" : "Record sessions"} disabled={recordLock.locked} className={effRecord ? "toggle on" : "toggle"} onClick={() => setRecord(!record)}><span /></button>
            </Row>
          )}
          {showKeystrokes && (
            <Row title="Keystroke log" custom={ctx.keystrokeMode !== "required" && keystrokes !== keystrokesDefault} desc={ctx.keystrokeMode === "required" ? "Required by the Policy page." : "Typed text, searchable later; password prompts stay hidden."}>
              <button type="button" role="switch" aria-checked={ctx.keystrokeMode === "required" || keystrokes} aria-label="Keystroke log" disabled={ctx.keystrokeMode === "required"}
                className={ctx.keystrokeMode === "required" || keystrokes ? "toggle on" : "toggle"} onClick={() => setKeystrokeChoice(!keystrokes)}><span /></button>
            </Row>
          )}
          {nativeRdpShown && (
            <Row title="Native RDP client" custom={nativeRdpOn} desc={nativeRdpRecorded
              ? "Users can also download an .rdp file and connect with their own Remote Desktop app (Windows, the Windows App on a Mac, FreeRDP). Captivo signs them in with the saved account, so they type no password, and records the screen and the typed text like a session in the browser. The clipboard and drives follow the rules below."
              : "Users can also download an .rdp file and connect with their own Remote Desktop app. Those sessions aren't recorded or watchable, and users sign in to the server with their own account."}>
              <button type="button" role="switch" aria-checked={nativeRdpOn} aria-label="Native RDP client" className={nativeRdpOn ? "toggle on" : "toggle"} onClick={() => setNativeRdp(!nativeRdp)}><span /></button>
            </Row>
          )}
          {nativeRdpOldConnector && <p className="rf-msg bad">The connector {connector?.name} runs {connector?.version}; native RDP needs {NATIVE_RDP_MIN_CONNECTOR} or later. Update it before users connect.</p>}
          {nativeRdpNeedsUpdate && <p className="rf-msg bad">Recording sessions in the user&apos;s own Remote Desktop app needs connector {NATIVE_RDP_RECORDED_MIN_CONNECTOR} or later; {connector?.name} runs {connector?.version}. {nativeRdpLocked ? "Until it is updated, users can't connect with their own Remote Desktop app." : "Until it is updated, those sessions aren't recorded."}</p>}
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
          {checkoutShown && (
            <Row title="Password check-out" custom={checkout} desc="Someone with an active grant can take this resource's password for a while, for a reason, to use it themselves (a console, a tool that can't go through Captivo). One person at a time; the connector seals it to their browser, so it never passes through the console readable. When the time is up, they give it back or the grant ends, the password is changed. Needs the password to be kept in Captivo, and a resource that needs a moderator can't offer it.">
              <button type="button" role="switch" aria-checked={checkout} aria-label="Password check-out" className={checkout ? "toggle on" : "toggle"} onClick={() => setCheckout(!checkout)}><span /></button>
            </Row>
          )}
          {checkoutShown && checkout && (
            <div className="rf-row">
              <span className="rf-row-t"><b>Longest check-out</b><span className="cell-sub">Sooner if the person&apos;s grant ends, or when they give it back.</span></span>
              <div className="rf-row-c"><Pills value={checkoutMinutes} onChange={setCheckoutMinutes} options={[["60", "1 hour"], ["240", "4 hours"], ["480", "8 hours"], ["1440", "24 hours"]]} label="Longest check-out" /></div>
            </div>
          )}
          {checkoutShown && checkout && (moderatedOn || source !== "local" || (isDb && !!sessionRole.trim())) && <p className="rf-msg warn">{moderatedOn ? "A resource that needs a moderator can't offer password check-out." : isDb && sessionRole.trim() ? "A resource that makes a user per connection has no shared password to check out." : source === "sshca" ? "A certificate sign-in has no password to check out." : "A credential kept in your own vault can't be checked out here; read it there."} It is left off when you save.</p>}
          {moderatedShown && (
            <Row title="Requires a moderator" custom={moderatedOn} desc="Four eyes: a session starts only when a moderator joins it from Live sessions, and the user can work only while the moderator watches. If the moderator leaves, the user's keyboard and mouse pause, and the session ends 2 minutes later unless a moderator joins. Who can moderate is set on the Policy page.">
              <button type="button" role="switch" aria-checked={moderatedOn} aria-label="Requires a moderator" className={moderatedOn ? "toggle on" : "toggle"} onClick={() => setModerated(!moderated)}><span /></button>
            </Row>
          )}
          {moderatedOn && ctx.moderators !== undefined && ctx.moderators < 2 && <p className="rf-msg bad">{ctx.moderators === 0
            ? "Nobody in this organization may moderate yet, so users can't start a session here. Add an admin or operator on the Users page, or change who can moderate on the Policy page."
            : "Only one person may moderate, and nobody moderates their own session: they can't use this resource themselves. Add another admin or operator on the Users page if they need to."}</p>}
          {moderatedOn && nativeRdpOn && <p className="rf-msg">A moderator can&apos;t watch the user&apos;s own Remote Desktop app yet, so users see only Open in the browser while a moderator is required.</p>}
          {moderatedOn && nativeSshOn && !nativeSshRecorded && <p className="rf-msg">A moderator can watch only a recorded session, so users can&apos;t use their own SSH app here until recording is on.</p>}
          {isKube && (
            <>
              <Row title="Read only" custom={kubeReadOnly} desc="Only get, list and watch: no changes, no kubectl exec or attach, and secrets can't be read. Captivo refuses the rest before it reaches the cluster.">
                <button type="button" role="switch" aria-checked={kubeReadOnly} aria-label="Read only" className={kubeReadOnly ? "toggle on" : "toggle"} onClick={() => setKubeReadOnly(!kubeReadOnly)}><span /></button>
              </Row>
              {!kubeReadOnly && (
                <Row title="Port forwarding" custom={kubePortForward} desc="kubectl port-forward and the API server's proxy to pods and services. What crosses them is not recorded; each one is logged.">
                  <button type="button" role="switch" aria-checked={kubePortForward} aria-label="Port forwarding" className={kubePortForward ? "toggle on" : "toggle"} onClick={() => setKubePortForward(!kubePortForward)}><span /></button>
                </Row>
              )}
            </>
          )}
          {!isDb && !isTunnel && !isKube && (
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
            <span className="rf-open">{isDb || isTunnel || isKube ? "Connect" : "Open"}</span>
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
