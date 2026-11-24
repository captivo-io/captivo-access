import { compareSemver } from "@/lib/updates/semver";

// Kubernetes resources (accessMode KUBERNETES): a cluster's API server reached
// with the user's own kubectl (Lens, k9s, Helm) through the data plane
// (dataplane/kubeproxy.go). The connector signs each request in with the saved
// service account token and, with impersonation, as the Captivo user
// (connector/kubeproxy.go), so the cluster's RBAC and audit log see the person.

export const KUBERNETES_MIN_CONNECTOR = "2.62.0";

/** How long a kubeconfig works, at most; never past the grant's end or the browser session's. */
export const KUBE_TICKET_TTL_MS = 8 * 3600_000;

/** The group every Captivo user acts in when no other is set. */
export const DEFAULT_KUBE_GROUP = "captivo-users";

export type KubeIdentity = "impersonate" | "service_account";

export type KubeParams = {
  /** The cluster's CA (PEM); null = the system roots (a managed cluster behind a public certificate). */
  caCertPem: string | null;
  /** The name the API server's certificate carries, when the address isn't one of its names. */
  serverName: string | null;
  /** impersonate: each request acts as the Captivo user; service_account: as the account itself. */
  identity: KubeIdentity;
  /** The groups a user acts in (impersonation). */
  groups: string[];
  /** The only namespaces reachable; empty = all of them. */
  namespaces: string[];
  /** get, list and watch only; no exec, no secrets. */
  readOnly: boolean;
  /** kubectl port-forward and the API server's proxy to pods and services. */
  portForward: boolean;
};

const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

export const validNamespace = (s: string) => NAMESPACE_RE.test(s);

/** A group a user may be made to act in: never a system: group (system:masters is cluster-admin). */
export const validGroup = (s: string) => GROUP_RE.test(s) && !s.toLowerCase().startsWith("system:");

function list(v: unknown, ok: (s: string) => boolean, max: number): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const out = [...new Set(raw.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))];
  if (out.length > max || out.some((x) => !ok(x))) return null;
  return out;
}

/** Reads stored params, falling back to safe defaults for anything missing. */
export function parseKubeParams(v: unknown): KubeParams {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const caCertPem = typeof o.caCertPem === "string" && o.caCertPem.includes("BEGIN CERTIFICATE") ? o.caCertPem.trim() : null;
  const serverName = typeof o.serverName === "string" && HOST_RE.test(o.serverName) ? o.serverName : null;
  const groups = list(o.groups, validGroup, 20) ?? [];
  return {
    caCertPem, serverName,
    identity: o.identity === "service_account" ? "service_account" : "impersonate",
    groups: groups.length ? groups : [DEFAULT_KUBE_GROUP],
    namespaces: list(o.namespaces, validNamespace, 50) ?? [],
    readOnly: o.readOnly === true,
    portForward: o.portForward === true,
  };
}

/** Validates a form/API body's Kubernetes fields. */
export function kubeParamsFrom(body: Record<string, unknown>): KubeParams | { error: string } {
  const ca = typeof body.caCertPem === "string" ? body.caCertPem.trim() : "";
  if (ca && (!ca.includes("BEGIN CERTIFICATE") || ca.length > 20_000)) return { error: "invalid_ca_cert" };
  const serverName = typeof body.serverName === "string" ? body.serverName.trim() : "";
  if (serverName && !HOST_RE.test(serverName)) return { error: "invalid_server_name" };
  const groups = list(body.kubeGroups, validGroup, 20);
  if (groups === null) return { error: "invalid_kube_group" };
  const namespaces = list(body.namespaces, validNamespace, 50);
  if (namespaces === null) return { error: "invalid_namespace" };
  return {
    caCertPem: ca || null,
    serverName: serverName || null,
    identity: body.kubeIdentity === "service_account" ? "service_account" : "impersonate",
    groups: groups.length ? groups : [DEFAULT_KUBE_GROUP],
    namespaces,
    readOnly: body.readOnly === true,
    portForward: body.portForward === true && body.readOnly !== true,
  };
}

/**
 * The API server's address as an admin pastes it: "10.0.0.5:6443",
 * "https://k8s.internal:6443" or a bare host (port 443, a managed cluster's).
 */
export function parseApiServer(v: string): { host: string; port: number } | null {
  let s = v.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.username) return null;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const port = u.port ? Number(u.port) : 443;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

export const apiServerLabel = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

export type KubeBlock = "not_kubernetes" | "connector_outdated";

/** Why a Kubernetes resource can't be opened now, or null when it can. */
export function kubeBlock(s: { accessMode: string; connectorVersion: string | null | undefined }): KubeBlock | null {
  if (s.accessMode !== "KUBERNETES") return "not_kubernetes";
  if (compareSemver(s.connectorVersion, KUBERNETES_MIN_CONNECTOR) === -1) return "connector_outdated";
  return null;
}

/** The kubeconfig's server: the console's own origin, under /k8s/. */
export function kubeServerUrl(consoleOrigin: string, siteId: string): string {
  return `${consoleOrigin.replace(/\/+$/, "")}/k8s/${encodeURIComponent(siteId)}`;
}

/** A name for the cluster and context: "captivo-prod-cluster". */
export function kubeContextName(siteName: string): string {
  const slug = siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `captivo-${slug || "cluster"}`;
}

/** The kubeconfig the portal hands out. Every value in it is plain (no quoting needed). */
export function kubeconfigYaml(o: { server: string; context: string; token: string; namespace: string | null; expiresAt: Date }): string {
  return [
    "# Captivo Access: works until " + o.expiresAt.toISOString().replace(/\.\d+Z$/, "Z") + ". Get a new one from the portal after that.",
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    `- name: ${o.context}`,
    "  cluster:",
    `    server: ${o.server}`,
    "contexts:",
    `- name: ${o.context}`,
    "  context:",
    `    cluster: ${o.context}`,
    `    user: ${o.context}`,
    ...(o.namespace ? [`    namespace: ${o.namespace}`] : []),
    `current-context: ${o.context}`,
    "users:",
    `- name: ${o.context}`,
    "  user:",
    `    token: ${o.token}`,
    "",
  ].join("\n");
}

/**
 * What the cluster's admin applies once: a service account for Captivo with a
 * long-lived token, and either the right to impersonate (only the groups this
 * resource names) plus a starting role for those groups, or a role for the
 * account itself. The token and CA come out of the Secret it creates.
 */
export function kubeSetupYaml(o: { identity: KubeIdentity; groups: string[]; readOnly: boolean }): string {
  const role = o.readOnly ? "view" : "edit";
  const head = [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    "  name: captivo",
    "---",
    "apiVersion: v1",
    "kind: ServiceAccount",
    "metadata:",
    "  name: captivo-access",
    "  namespace: captivo",
    "---",
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    "  name: captivo-access-token",
    "  namespace: captivo",
    "  annotations:",
    "    kubernetes.io/service-account.name: captivo-access",
    "type: kubernetes.io/service-account-token",
  ];
  if (o.identity === "service_account") {
    return [
      ...head,
      "---",
      `# What every Captivo user may do: the built-in "${role}" role. Narrow it as you like.`,
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: ClusterRoleBinding",
      "metadata:",
      `  name: captivo-access-${role}`,
      "roleRef:",
      "  apiGroup: rbac.authorization.k8s.io",
      "  kind: ClusterRole",
      `  name: ${role}`,
      "subjects:",
      "- kind: ServiceAccount",
      "  name: captivo-access",
      "  namespace: captivo",
      "",
    ].join("\n");
  }
  const groups = o.groups.length ? o.groups : [DEFAULT_KUBE_GROUP];
  return [
    ...head,
    "---",
    "# Captivo acts as each user, in these groups only; it can't act as cluster-admin.",
    "apiVersion: rbac.authorization.k8s.io/v1",
    "kind: ClusterRole",
    "metadata:",
    "  name: captivo-access-impersonator",
    "rules:",
    "- apiGroups: [\"\"]",
    "  resources: [\"users\"]",
    "  verbs: [\"impersonate\"]",
    "- apiGroups: [\"\"]",
    "  resources: [\"groups\"]",
    "  verbs: [\"impersonate\"]",
    `  resourceNames: [${groups.map((g) => JSON.stringify(g)).join(", ")}]`,
    "---",
    "apiVersion: rbac.authorization.k8s.io/v1",
    "kind: ClusterRoleBinding",
    "metadata:",
    "  name: captivo-access-impersonator",
    "roleRef:",
    "  apiGroup: rbac.authorization.k8s.io",
    "  kind: ClusterRole",
    "  name: captivo-access-impersonator",
    "subjects:",
    "- kind: ServiceAccount",
    "  name: captivo-access",
    "  namespace: captivo",
    "---",
    `# What Captivo users may do: the built-in "${role}" role for the ${groups[0]} group.`,
    "# Bind roles to a user's e-mail address or another group to narrow it.",
    "apiVersion: rbac.authorization.k8s.io/v1",
    "kind: ClusterRoleBinding",
    "metadata:",
    `  name: ${groups[0].replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${role}`,
    "roleRef:",
    "  apiGroup: rbac.authorization.k8s.io",
    "  kind: ClusterRole",
    `  name: ${role}`,
    "subjects:",
    "- kind: Group",
    `  name: ${groups[0]}`,
    "  apiGroup: rbac.authorization.k8s.io",
    "",
  ].join("\n");
}

/** Reads the token and the CA out of the Secret the setup created. */
export const KUBE_TOKEN_COMMAND = "kubectl -n captivo get secret captivo-access-token -o jsonpath='{.data.token}' | base64 -d";
export const KUBE_CA_COMMAND = "kubectl -n captivo get secret captivo-access-token -o jsonpath='{.data.ca\\.crt}' | base64 -d";
